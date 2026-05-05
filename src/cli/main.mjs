#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const SERVER = "http://127.0.0.1:17654";
const STATE_DIR = path.join(ROOT, ".state");
const REFS_FILE = path.join(STATE_DIR, "refs.json");
const CURRENT_FILE = path.join(STATE_DIR, "current-tab.json");
const CONFIRM_FILE = path.join(STATE_DIR, "confirmations.json");
const LAUNCH_AGENT_LABEL = "dev.my-browser.local-agent";
const LAUNCH_AGENT_PATH = `${process.env.HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`;
const EXTENSION_ID = "idkehddnilelcbbeebnmkombjaekhdoe";
const EXTENSION_PATH = path.join(ROOT, "local-browser-operator-extension");
const MY_BROWSER = path.join(ROOT, "scripts/my-browser");

function usage() {
  console.log(`my-browser - local real-Chrome automation CLI for AI agents

Usage:
  my-browser status
  my-browser ensure
  my-browser doctor
  my-browser diagnostics
  my-browser setup [--dry-run|--guided]
  my-browser install-help [--copy] [--open]
  my-browser tabs
  my-browser open|goto <url> [tabId] [--group-name name] [--group-color color] [--active] [--front]
  my-browser navigate <url> <tabId>
  my-browser close [tabId]
  my-browser snapshot [tabId] [--json] [-s selector] [-n count] [--full]
  my-browser get <title|url>
  my-browser get <text|html|value|checked|box|styles> <selector|@ref>
  my-browser get attr <name> <selector|@ref>
  my-browser get count <selector>
  my-browser is <visible|enabled|checked> <selector|@ref>
  my-browser text [selector|@ref] [--limit count]
  my-browser fields [tabId] <name=selector|@ref>...
  my-browser summary [tabId] [-s selector] [--limit count]
  my-browser find <text|placeholder|label|role> <value> [--name name] [-n count] [tabId]
  my-browser wait <ms|selector|@ref>
  my-browser wait --text <text>
  my-browser wait --text-gone <text>
  my-browser wait --url <glob>
  my-browser wait --fn <js>
  my-browser wait --load <domcontentloaded|load|networkidle>
  my-browser wait <selector|@ref> --state <visible|hidden|detached>
  my-browser click <selector|@ref>
  my-browser dblclick <selector|@ref>
  my-browser hover <selector|@ref>
  my-browser focus <selector|@ref>
  my-browser fill <selector|@ref> <text>
  my-browser type <selector|@ref> <text>
  my-browser type --active <text>
  my-browser keyboard type <text>
  my-browser keyboard inserttext <text>
  my-browser upload <selector|@ref> <file...>
  my-browser check <selector|@ref>
  my-browser uncheck <selector|@ref>
  my-browser select <selector|@ref> <value-or-label>
  my-browser scroll <up|down|left|right> [pixels]
  my-browser scroll <top|bottom>
  my-browser scroll <selector|@ref>
  my-browser scrollintoview <selector|@ref>
  my-browser press <key>
  my-browser mouse <move|down|up|wheel> ...
  my-browser eval <js> [tabId] [--limit count]
  my-browser eval --stdin [tabId] [--limit count]
  my-browser screenshot [--annotate] <path> [tabId]
  my-browser console [--clear]
  my-browser errors [--clear]
  my-browser requests [--clear]
  my-browser confirm <id>
  my-browser deny <id>
  my-browser detach
`);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${SERVER}${pathname}`, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function canReachAgent() {
  try {
    await request("/");
    return true;
  } catch {
    return false;
  }
}

async function waitForAgent(timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canReachAgent()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function launchAgentPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(ROOT, "local-agent.mjs")}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(ROOT, ".state", "local-agent.out.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(ROOT, ".state", "local-agent.err.log")}</string>
</dict>
</plist>
`;
}

async function runSetup(args) {
  const { spawnSync } = await import("node:child_process");
  const dryRun = args.includes("--dry-run");
  const guided = args.includes("--guided");
  const plan = {
    launchAgentLabel: LAUNCH_AGENT_LABEL,
    launchAgentPath: LAUNCH_AGENT_PATH,
    localAgent: path.join(ROOT, "local-agent.mjs"),
    extensionPath: EXTENSION_PATH,
    extensionId: EXTENSION_ID,
    actions: [
      "write LaunchAgent plist",
      "bootstrap and kickstart local agent",
      "check extension directory and manifest",
      guided ? "open guided extension install/reload helper" : "print extension guidance only"
    ],
    dryRun
  };
  if (dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  ensureStateDir();
  fs.mkdirSync(path.dirname(LAUNCH_AGENT_PATH), { recursive: true });
  fs.writeFileSync(LAUNCH_AGENT_PATH, launchAgentPlist());
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, LAUNCH_AGENT_PATH], { stdio: "ignore" });
  const bootstrap = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, LAUNCH_AGENT_PATH], { stdio: "pipe", encoding: "utf8" });
  const kickstart = spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], { stdio: "pipe", encoding: "utf8" });
  const manifestPath = path.join(EXTENSION_PATH, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const report = {
    ...plan,
    dryRun: false,
    launchctl: {
      bootstrapStatus: bootstrap.status,
      bootstrapStderr: bootstrap.stderr?.trim() || undefined,
      kickstartStatus: kickstart.status,
      kickstartStderr: kickstart.stderr?.trim() || undefined
    },
    manifest: {
      name: manifest.name,
      version: manifest.version,
      background: manifest.background
    },
    agentReachable: await waitForAgent(4000)
  };
  if (guided) {
    const helper = path.join(ROOT, "scripts", "install-extension-helper.sh");
    const result = spawnSync(helper, [], { stdio: "inherit" });
    report.guidedHelperStatus = result.status ?? 0;
  }
  console.log(JSON.stringify(report, null, 2));
}

async function send(command) {
  const protocolCommand = {
    protocol: "my-browser/v2",
    sentAt: new Date().toISOString(),
    ...command
  };
  const queued = await request("/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(protocolCommand)
  });

  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await request(`/result/${queued.id}`);
    if (result && !result.pending) {
      if (!result.ok) throw new Error(result.error || "Command failed");
      return result.result;
    }
  }
  throw new Error(`Timed out waiting for ${queued.id}`);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function saveRefs(payload) {
  ensureStateDir();
  fs.writeFileSync(REFS_FILE, JSON.stringify(payload, null, 2));
}

function saveCurrentTab(tabId, extra = {}) {
  if (!tabId) return;
  ensureStateDir();
  fs.writeFileSync(CURRENT_FILE, JSON.stringify({ tabId, ...extra }, null, 2));
}

function loadConfirmations() {
  try {
    return JSON.parse(fs.readFileSync(CONFIRM_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfirmations(confirmations) {
  ensureStateDir();
  fs.writeFileSync(CONFIRM_FILE, JSON.stringify(confirmations, null, 2));
}

function saveConfirmation(action) {
  const confirmations = loadConfirmations();
  const id = `confirm-${Date.now().toString(36)}`;
  confirmations[id] = {
    id,
    createdAt: new Date().toISOString(),
    action
  };
  saveConfirmations(confirmations);
  return id;
}

function loadRefs() {
  return JSON.parse(fs.readFileSync(REFS_FILE, "utf8"));
}

function refNumber(ref) {
  const match = /^@e(\d+)$/.exec(ref);
  if (!match) throw new Error(`Expected a ref like @e1, got ${ref}`);
  return Number(match[1]);
}

function snapshotExpression(options = {}) {
  const scopeSelector = options.scopeSelector || null;
  const limit = Number.isFinite(options.limit) ? options.limit : 50;
  const labelLimit = options.full ? 160 : 70;
  return `(() => {
    const interactiveSelector = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="checkbox"]',
      '[role="menuitem"]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const scopeSelector = ${JSON.stringify(scopeSelector)};
    const limit = ${JSON.stringify(limit)};
    const labelLimit = ${JSON.stringify(labelLimit)};
    const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
    if (!scope) throw new Error('Snapshot scope not found: ' + scopeSelector);

    function roleOf(el) {
      if (el.getAttribute('role')) return el.getAttribute('role');
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button') return 'button';
        return 'textbox';
      }
      return tag;
    }

    function labelOf(el) {
      const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder');
      if (aria) return aria.trim();
      if (el.id) {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label?.innerText) return label.innerText.trim();
      }
      const text = (el.innerText || el.value || el.alt || '').replace(/\\s+/g, ' ').trim();
      return text.slice(0, labelLimit);
    }

    function cssPath(el) {
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        if (node.id) {
          parts.unshift('#' + CSS.escape(node.id));
          break;
        }
        const tag = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (!parent) break;
        const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
        const index = siblings.indexOf(node) + 1;
        parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
        node = parent;
      }
      return parts.join(' > ');
    }

    const elements = [...scope.querySelectorAll(interactiveSelector)]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })
      .slice(0, limit)
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        return {
          ref: '@e' + (index + 1),
          role: roleOf(el),
          name: labelOf(el),
          selector: cssPath(el),
          href: el.href || undefined,
          value: el.value || undefined,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      });

    return JSON.stringify({
      title: document.title,
      url: location.href,
      scope: scopeSelector || undefined,
      truncated: scope.querySelectorAll(interactiveSelector).length > limit,
      elements
    });
  })()`;
}

function printSnapshot(snapshot) {
  console.log(`Page: ${snapshot.title}`);
  console.log(`URL: ${snapshot.url}`);
  if (snapshot.scope) console.log(`Scope: ${snapshot.scope}`);
  if (snapshot.truncated) console.log("Note: truncated; use -n <count> or -s <selector> for a tighter view.");
  console.log("");
  for (const el of snapshot.elements) {
    const name = el.name ? ` "${el.name}"` : "";
    const href = el.href ? ` href="${el.href}"` : "";
    const value = el.value ? ` value="${el.value}"` : "";
    console.log(`${el.ref} [${el.role}]${name}${href}${value}`);
  }
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function refElement(ref) {
  const snapshot = loadRefs();
  const el = snapshot.elements[refNumber(ref) - 1];
  if (!el) throw new Error(`Missing ref ${ref}; run snapshot again`);
  return { snapshot, el };
}

async function evalValue(expression, tabId) {
  const result = await send({ type: "eval", tabId, expression });
  const remote = result.result;
  if (remote?.type === "undefined") return undefined;
  return remote?.value;
}

function selectorExpression(selector, body) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Element not found');
    return (${body});
  })()`;
}

function compactTextExpression(selector, limit) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Element not found');
    const text = ('innerText' in el ? el.innerText : el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text.slice(0, ${Number(limit)});
  })()`;
}

function stateExpression(selector, what) {
  return selectorExpression(selector, `(() => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (${JSON.stringify(what)} === 'visible') {
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    if (${JSON.stringify(what)} === 'enabled') {
      return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    }
    if (${JSON.stringify(what)} === 'checked') {
      if ('checked' in el) return Boolean(el.checked);
      if (el.getAttribute('role') === 'checkbox') return el.getAttribute('aria-checked') === 'true';
      return false;
    }
    throw new Error('Unsupported state');
  })()`);
}

function boxExpression(selector) {
  return selectorExpression(selector, `(() => {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centerX: Math.round(rect.left + rect.width / 2),
      centerY: Math.round(rect.top + rect.height / 2)
    };
  })()`);
}

function stylesExpression(selector) {
  return selectorExpression(selector, `(() => {
    const style = getComputedStyle(el);
    return {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      color: style.color,
      backgroundColor: style.backgroundColor,
      pointerEvents: style.pointerEvents,
      position: style.position,
      zIndex: style.zIndex
    };
  })()`);
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function printLimited(value, limit) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (Number.isFinite(limit) && text.length > limit) {
    console.log(text.slice(0, limit));
    console.log(`\n[truncated ${text.length - limit} chars; increase --limit if needed]`);
    return;
  }
  console.log(text);
}

function isRef(value) {
  return /^@e\d+$/.test(value || "");
}

function loadSnapshotTabId() {
  try {
    return JSON.parse(fs.readFileSync(CURRENT_FILE, "utf8")).tabId;
  } catch {}
  try {
    return loadRefs().tabId;
  } catch {
    return undefined;
  }
}

function targetElement(target) {
  if (!target) throw new Error("Missing target");
  if (isRef(target)) {
    const { snapshot, el } = refElement(target);
    return {
      tabId: snapshot.tabId,
      selector: el.selector,
      backendDOMNodeId: el.backendDOMNodeId,
      ref: target,
      element: el
    };
  }
  return { tabId: loadSnapshotTabId(), selector: target, ref: null, element: null };
}

async function targetPoint(target) {
  const resolved = targetElement(target);
  if (resolved.backendDOMNodeId) {
    try {
      const box = await send({
        type: "element-box",
        tabId: resolved.tabId,
        backendDOMNodeId: resolved.backendDOMNodeId,
        selector: resolved.selector
      });
      return { ...resolved, ...box };
    } catch (error) {
      if (!String(error?.message ?? error).includes("Unsupported command type")) throw error;
    }
  }
  if (resolved.element?.x !== undefined && resolved.element?.y !== undefined) {
    return { ...resolved, x: resolved.element.x, y: resolved.element.y };
  }
  const point = await evalValue(selectorExpression(resolved.selector, `(() => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('Element has no clickable area');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const next = el.getBoundingClientRect();
    return {
      x: Math.round(next.left + next.width / 2),
      y: Math.round(next.top + next.height / 2),
      width: Math.round(next.width),
      height: Math.round(next.height)
    };
  })()`), resolved.tabId);
  return { ...resolved, ...point };
}

const RISKY_ACTION_RE = /(发布|发表|立即投稿|提交订单|删除|支付|付款|Publish|Post|Submit|Delete|Pay)/i;

function targetLabel(resolved) {
  return [
    resolved.element?.name,
    resolved.element?.role,
    resolved.element?.value,
    resolved.selector
  ].filter(Boolean).join(" ");
}

function maybeRequireConfirmation(commandName, target, resolved, payload) {
  if (!["click", "dblclick"].includes(commandName)) return null;
  const label = targetLabel(resolved);
  if (!RISKY_ACTION_RE.test(label)) return null;
  const id = saveConfirmation({
    commandName,
    target,
    payload,
    label
  });
  return {
    ok: false,
    confirmationRequired: true,
    id,
    reason: "Target text looks like a final publish, payment, delete, or submit action.",
    target: label,
    next: `${MY_BROWSER} confirm ${id}`
  };
}

async function replayConfirmed(action) {
  if (action.commandName === "click" || action.commandName === "dblclick") {
    return send(action.payload);
  }
  throw new Error(`Unsupported confirmed action: ${action.commandName}`);
}

function firstOptionValue(args, names, fallback) {
  for (let i = 0; i < args.length; i += 1) {
    if (names.includes(args[i])) return args[i + 1] ?? fallback;
  }
  return fallback;
}

function withoutOptions(args, optionNamesWithValue, optionNamesWithoutValue = []) {
  const output = [];
  for (let i = 0; i < args.length; i += 1) {
    if (optionNamesWithValue.includes(args[i])) {
      i += 1;
      continue;
    }
    if (optionNamesWithoutValue.includes(args[i])) continue;
    output.push(args[i]);
  }
  return output;
}

function fieldsExpression(specs) {
  return `(() => {
    const specs = ${JSON.stringify(specs)};
    const result = {};
    for (const spec of specs) {
      const el = document.querySelector(spec.selector);
      if (!el) {
        result[spec.name] = { exists: false, value: null };
        continue;
      }
      let value = null;
      const inputType = (el.getAttribute('type') || '').toLowerCase();
      if ('checked' in el && (inputType === 'checkbox' || inputType === 'radio')) value = Boolean(el.checked);
      else if (el.getAttribute('role') === 'checkbox') value = el.getAttribute('aria-checked') === 'true';
      else if ('value' in el) value = el.value;
      else value = ('innerText' in el ? el.innerText : el.textContent || '').replace(/\\s+/g, ' ').trim();
      result[spec.name] = {
        exists: true,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        value
      };
    }
    return JSON.stringify(result);
  })()`;
}

function summaryExpression(options = {}) {
  const scopeSelector = options.scopeSelector || "body";
  const limit = Number.isFinite(options.limit) ? options.limit : 800;
  return `(() => {
    const scopeSelector = ${JSON.stringify(scopeSelector)};
    const limit = ${JSON.stringify(limit)};
    const scope = document.querySelector(scopeSelector);
    if (!scope) throw new Error('Summary scope not found: ' + scopeSelector);
    const rawText = ('innerText' in scope ? scope.innerText : scope.textContent || '').replace(/\\s+/g, ' ').trim();
    const lines = rawText.split(/(?<=[。！？.!?])\\s+|\\n+/).map((line) => line.trim()).filter(Boolean);
    const statusPattern = /(上传|发布|保存|成功|失败|错误|异常|登录|扫码|审核|处理中|完成|进度|草稿|必填|原创|声明|required|error|success|loading|upload|publish|draft)/i;
    const status = lines.filter((line) => statusPattern.test(line)).slice(0, 12).map((line) => line.slice(0, 120));
    const count = (selector) => scope.querySelectorAll(selector).length;
    return JSON.stringify({
      title: document.title,
      url: location.href,
      scope: scopeSelector,
      text: rawText.slice(0, limit),
      status,
      counts: {
        buttons: count('button,[role="button"]'),
        inputs: count('input'),
        textareas: count('textarea'),
        selects: count('select'),
        fileInputs: count('input[type="file"]'),
        checkboxes: count('input[type="checkbox"],[role="checkbox"]'),
        dialogs: document.querySelectorAll('[role="dialog"],dialog,.modal,.semi-modal').length
      },
      activeElement: document.activeElement ? {
        tag: document.activeElement.tagName.toLowerCase(),
        id: document.activeElement.id || undefined,
        placeholder: document.activeElement.getAttribute('placeholder') || undefined
      } : null
    });
  })()`;
}

function findExpression(kind, value, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 20;
  const name = options.name || "";
  return `(() => {
    const kind = ${JSON.stringify(kind)};
    const needle = ${JSON.stringify(value)}.toLowerCase();
    const nameNeedle = ${JSON.stringify(name)}.toLowerCase();
    const limit = ${JSON.stringify(limit)};
    const interactiveSelector = [
      'a[href]',
      'button',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="checkbox"]',
      '[role="menuitem"]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    function roleOf(el) {
      if (el.getAttribute('role')) return el.getAttribute('role');
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button') return 'button';
        return 'textbox';
      }
      return tag;
    }

    function cssPath(el) {
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        if (node.id) {
          parts.unshift('#' + CSS.escape(node.id));
          break;
        }
        const tag = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (!parent) break;
        const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
        const index = siblings.indexOf(node) + 1;
        parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
        node = parent;
      }
      return parts.join(' > ');
    }

    function labelOf(el) {
      const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder');
      if (aria) return aria.trim();
      if (el.id) {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label?.innerText) return label.innerText.trim();
      }
      return (el.innerText || el.value || el.alt || '').replace(/\\s+/g, ' ').trim();
    }

    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    const pool = kind === 'text' ? [...document.querySelectorAll('body *')] : [...document.querySelectorAll(interactiveSelector)];
    const matches = [];
    for (const el of pool) {
      if (!visible(el)) continue;
      const role = roleOf(el);
      const label = labelOf(el);
      const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const placeholder = el.getAttribute('placeholder') || '';
      let ok = false;
      if (kind === 'placeholder') ok = placeholder.toLowerCase().includes(needle);
      else if (kind === 'label') ok = label.toLowerCase().includes(needle);
      else if (kind === 'role') ok = role.toLowerCase() === needle && (!nameNeedle || label.toLowerCase().includes(nameNeedle));
      else if (kind === 'text') ok = text.toLowerCase().includes(needle) || label.toLowerCase().includes(needle);
      else throw new Error('Unsupported find kind: ' + kind);
      if (!ok) continue;
      const rect = el.getBoundingClientRect();
      matches.push({
        ref: '@e' + (matches.length + 1),
        role,
        name: label.slice(0, 80),
        text: text.slice(0, 120) || undefined,
        selector: cssPath(el),
        value: el.value || undefined,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
      if (matches.length >= limit) break;
    }
    return JSON.stringify({ title: document.title, url: location.href, find: { kind, value: ${JSON.stringify(value)}, name: ${JSON.stringify(name)} || undefined }, elements: matches });
  })()`;
}

async function waitUntil(check, timeoutMs = 25000, intervalMs = 500) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await check()) return true;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(lastError ? `Timed out: ${lastError.message}` : "Timed out waiting for condition");
}

export async function main() {
  let [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === "help") {
    usage();
    return;
  }
  if (!command) {
    usage();
    process.exit(1);
  }
  if (command === "goto") command = "open";
  if (command === "key") command = "press";

  if (command === "status") {
    console.log(JSON.stringify(await request("/"), null, 2));
    return;
  }

  if (command === "ensure") {
    const { spawn } = await import("node:child_process");
    let startedAgent = false;
    if (!(await canReachAgent())) {
      const child = spawn(process.execPath, [path.join(ROOT, "local-agent.mjs")], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      startedAgent = true;
      await waitForAgent();
    }

    let status = null;
    let agentReachable = false;
    try {
      status = await request("/");
      agentReachable = true;
      if ((status.queue ?? 0) > 0) {
        await request("/clear", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ queue: true, results: false })
        }).catch(() => null);
        status = await request("/");
      }
    } catch {}

    const heartbeatAgeMs = status?.lastClientSeenAt ? Date.now() - Date.parse(status.lastClientSeenAt) : null;
    const extensionOnline = Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs < 5000;
    const report = {
      agentReachable,
      startedAgent,
      extensionOnline,
      heartbeatAgeMs,
      queue: status?.queue ?? null,
      lastClientId: status?.lastClientId ?? null,
      lastClientSeenAt: status?.lastClientSeenAt ?? null,
      advice: []
    };

    if (!agentReachable) {
      report.advice.push("Could not start the local agent.");
    } else if (!extensionOnline) {
      report.advice.push("The Chrome extension background operator is not polling yet. Reload the extension once if the background update was just installed.");
    }

    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (command === "doctor") {
    const report = {
      agentReachable: false,
      extensionSeen: false,
      extensionPath: EXTENSION_PATH,
      extensionId: EXTENSION_ID,
      lastClientId: null,
      lastClientSeenAt: null,
      queue: null,
      advice: []
    };

    try {
      const status = await request("/");
      report.agentReachable = true;
      report.lastClientId = status.lastClientId ?? null;
      report.lastClientSeenAt = status.lastClientSeenAt ?? null;
      report.queue = status.queue ?? null;
      if (!status.lastClientId) {
        report.advice.push("The Chrome extension background operator has not checked in yet. Reload the extension once if it was just updated.");
      } else if (status.lastClientSeenAt) {
        const heartbeatAgeMs = Date.now() - Date.parse(status.lastClientSeenAt);
        report.heartbeatAgeMs = heartbeatAgeMs;
        if (!Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > 5000) {
          report.advice.push("The extension heartbeat is stale. Reload the extension if it was just updated; the options page is only for status.");
        }
      }
      if (status.queue > 0) {
        report.advice.push("There are pending commands. If the extension is not polling, reload the extension.");
      }
    } catch {
      report.advice.push(`Start the local agent: node ${path.join(ROOT, "local-agent.mjs")}`);
    }

    const securePreferencesPath = `${process.env.HOME}/Library/Application Support/Google/Chrome/Default/Secure Preferences`;
    try {
      const preferences = JSON.parse(fs.readFileSync(securePreferencesPath, "utf8"));
      const settings = preferences.extensions?.settings?.[report.extensionId];
      report.extensionSeen = Boolean(settings);
      if (!settings) {
      report.advice.push("Install or reload the unpacked extension from the extension path.");
      }
    } catch {
      report.advice.push("Could not inspect Chrome Secure Preferences.");
    }

    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (command === "diagnostics") {
    const agent = await request("/").catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
    let extension = null;
    if (agent.ok && agent.lastClientSeenAt) {
      extension = await send({ type: "diagnostics" }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
    }
    const heartbeatAgeMs = agent.lastClientSeenAt ? Date.now() - Date.parse(agent.lastClientSeenAt) : null;
    console.log(JSON.stringify({
      agent,
      extension,
      heartbeatAgeMs,
      extensionOnline: Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs < 5000,
      extensionPath: EXTENSION_PATH,
      extensionId: EXTENSION_ID,
      advice: extension?.ok === false
        ? ["Reload Local Browser Operator Lab in chrome://extensions so the v2 background operator becomes active."]
        : []
    }, null, 2));
    return;
  }

  if (command === "setup") {
    await runSetup(args);
    return;
  }

  if (command === "install-help") {
    const { spawnSync } = await import("node:child_process");
    const extensionId = EXTENSION_ID;
    const extensionPath = EXTENSION_PATH;
    if (args.includes("--open")) {
      const helper = path.join(ROOT, "scripts", "install-extension-helper.sh");
      const result = spawnSync(helper, [], { stdio: "inherit" });
      process.exit(result.status ?? 0);
    }
    if (args.includes("--copy")) {
      spawnSync("pbcopy", [], { input: extensionPath });
    }
    console.log(`Extension path${args.includes("--copy") ? " copied to clipboard" : ""}:
${extensionPath}

Quiet recovery mode:
1. When you are ready, open chrome://extensions/?id=${extensionId}
2. Find "Local Browser Operator Lab".
3. If it is already installed, click reload and accept any permission prompt.
4. If it is not installed, enable Developer mode, choose "Load unpacked", and select the extension path above.
5. Run ensure and doctor again.

This command does not open Chrome or change the clipboard by default.
To copy the extension path intentionally, run:
${MY_BROWSER} install-help --copy

To open the extension page intentionally, run:
${MY_BROWSER} install-help --open`);
    return;
  }

  if (command === "tabs") {
    const tabs = await send({ type: "tabs" });
    for (const tab of tabs) {
      const active = tab.active ? "*" : " ";
      console.log(`${active} ${tab.id} ${tab.title} ${tab.url}`);
    }
    return;
  }

  if (command === "open") {
    const active = args.includes("--active");
    const front = args.includes("--front");
    const groupTitle = firstOptionValue(args, ["--group-name", "--group-title"], null);
    const color = firstOptionValue(args, ["--group-color", "--color"], null);
    const cleanArgs = withoutOptions(args, ["--group-name", "--group-title", "--group-color", "--color"], ["--active", "--front"]);
    const [url, tabId] = cleanArgs;
    if (!url) throw new Error("Missing URL");
    let result;
    if (tabId) {
      result = await send({ type: "open", url, tabId: Number(tabId), group: false });
    } else {
      result = await send({ type: "open", url, active, front, groupTitle, color });
    }
    saveCurrentTab(result.tabId || Number(tabId), { url });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "navigate") {
    const [url, tabId] = args;
    if (!url || !tabId) throw new Error("Usage: navigate <url> <tabId>");
    const result = await send({ type: "open", url, tabId: Number(tabId), group: false });
    saveCurrentTab(Number(tabId), { url });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "close") {
    const [tabId] = args;
    const numericTabId = tabId ? Number(tabId) : loadSnapshotTabId();
    console.log(JSON.stringify(await send({ type: "close", tabId: numericTabId }), null, 2));
    return;
  }

  if (command === "snapshot") {
    const json = args.includes("--json");
    const full = args.includes("--full");
    let scopeSelector;
    let limit = 50;
    let tabId;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--json" || arg === "--full") continue;
      if (arg === "-s" || arg === "--selector") {
        scopeSelector = args[i + 1];
        if (!scopeSelector) throw new Error("Missing selector after -s");
        i += 1;
        continue;
      }
      if (arg === "-n" || arg === "--limit") {
        limit = Number(args[i + 1]);
        if (!Number.isFinite(limit) || limit < 1) throw new Error("Invalid snapshot limit");
        i += 1;
        continue;
      }
      if (tabId === undefined) {
        tabId = arg;
        continue;
      }
      throw new Error(`Unexpected snapshot argument: ${arg}`);
    }
    const numericTabId = tabId ? Number(tabId) : undefined;
    let snapshot;
    if (!scopeSelector) {
      try {
        snapshot = await send({ type: "snapshot", tabId: numericTabId, limit, full });
      } catch (error) {
        if (!String(error?.message ?? error).includes("Unsupported command type")) throw error;
        const result = await send({
          type: "eval",
          tabId: numericTabId,
          expression: snapshotExpression({ scopeSelector, limit, full })
        });
        snapshot = JSON.parse(result.result.value);
        snapshot.source = "dom-fallback";
      }
    } else {
      const result = await send({
        type: "eval",
        tabId: numericTabId,
        expression: snapshotExpression({ scopeSelector, limit, full })
      });
      snapshot = JSON.parse(result.result.value);
      snapshot.source = "dom";
    }
    if (numericTabId) snapshot.tabId = numericTabId;
    if (!snapshot.tabId) snapshot.tabId = loadSnapshotTabId();
    if (snapshot.tabId) saveCurrentTab(snapshot.tabId, { url: snapshot.url });
    saveRefs(snapshot);
    if (json) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      printSnapshot(snapshot);
    }
    return;
  }

  if (command === "get") {
    const [what, ...rest] = args;
    if (!what) throw new Error("Missing get target");

    if (what === "title") {
      console.log(await evalValue("document.title"));
      return;
    }
    if (what === "url") {
      console.log(await evalValue("location.href"));
      return;
    }
    if (what === "count") {
      const [selector] = rest;
      if (!selector) throw new Error("Missing selector");
      console.log(await evalValue(`document.querySelectorAll(${JSON.stringify(selector)}).length`));
      return;
    }
    if (what === "attr") {
      const [name, target] = rest;
      if (!name || !target) throw new Error("Usage: get attr <name> <selector|@ref>");
      const { tabId, selector } = targetElement(target);
      console.log(await evalValue(selectorExpression(selector, `el.getAttribute(${JSON.stringify(name)})`), tabId));
      return;
    }

    const [target] = rest;
    if (!target) throw new Error(`Usage: get ${what} <selector|@ref>`);
    const { tabId, selector } = targetElement(target);
    if (what === "text") {
      console.log(await evalValue(selectorExpression(selector, "`innerText` in el ? el.innerText : el.textContent"), tabId));
      return;
    }
    if (what === "html") {
      console.log(await evalValue(selectorExpression(selector, "el.innerHTML"), tabId));
      return;
    }
    if (what === "value") {
      console.log(await evalValue(selectorExpression(selector, "`value` in el ? el.value : null"), tabId));
      return;
    }
    if (what === "checked") {
      console.log(await evalValue(selectorExpression(selector, `(() => {
        if ('checked' in el) return Boolean(el.checked);
        if (el.getAttribute('role') === 'checkbox') return el.getAttribute('aria-checked') === 'true';
        return null;
      })()`), tabId));
      return;
    }
    if (what === "box") {
      console.log(JSON.stringify(await evalValue(boxExpression(selector), tabId), null, 2));
      return;
    }
    if (what === "styles") {
      console.log(JSON.stringify(await evalValue(stylesExpression(selector), tabId), null, 2));
      return;
    }
    throw new Error(`Unsupported get target: ${what}`);
  }

  if (command === "is") {
    const [what, target] = args;
    if (!["visible", "enabled", "checked"].includes(what) || !target) {
      throw new Error("Usage: is <visible|enabled|checked> <selector|@ref>");
    }
    const { tabId, selector } = targetElement(target);
    console.log(Boolean(await evalValue(stateExpression(selector, what), tabId)));
    return;
  }

  if (command === "text") {
    const limit = Number(firstOptionValue(args, ["--limit", "-l"], 800));
    if (!Number.isFinite(limit) || limit < 1) throw new Error("Invalid text limit");
    const cleanArgs = withoutOptions(args, ["--limit", "-l"]);
    const target = cleanArgs[0] || "body";
    const { tabId, selector } = targetElement(target);
    console.log(await evalValue(compactTextExpression(selector, limit), tabId));
    return;
  }

  if (command === "fields") {
    const cleanArgs = [...args];
    let tabId;
    if (/^\d+$/.test(cleanArgs[0] || "")) {
      tabId = Number(cleanArgs.shift());
    }
    if (!cleanArgs.length) throw new Error("Usage: fields [tabId] <name=selector|@ref>...");
    const specs = cleanArgs.map((pair) => {
      const index = pair.indexOf("=");
      if (index <= 0) throw new Error(`Expected name=selector, got ${pair}`);
      const name = pair.slice(0, index);
      const rawSelector = pair.slice(index + 1);
      if (isRef(rawSelector)) {
        const resolved = targetElement(rawSelector);
        if (!tabId) tabId = resolved.tabId;
        return { name, selector: resolved.selector };
      }
      return { name, selector: rawSelector };
    });
    const value = await evalValue(fieldsExpression(specs), tabId || loadSnapshotTabId());
    console.log(value);
    return;
  }

  if (command === "summary") {
    const limit = Number(firstOptionValue(args, ["--limit", "-l"], 800));
    if (!Number.isFinite(limit) || limit < 1) throw new Error("Invalid summary limit");
    const scopeSelector = firstOptionValue(args, ["-s", "--selector"], "body");
    const cleanArgs = withoutOptions(args, ["--limit", "-l", "-s", "--selector"]);
    const tabId = cleanArgs.find((arg) => /^\d+$/.test(arg));
    const numericTabId = tabId ? Number(tabId) : loadSnapshotTabId();
    const value = await evalValue(summaryExpression({ scopeSelector, limit }), numericTabId);
    if (numericTabId) saveCurrentTab(numericTabId);
    console.log(value);
    return;
  }

  if (command === "find") {
    const [kind, ...rest] = args;
    if (!kind || !["text", "placeholder", "label", "role"].includes(kind)) {
      throw new Error("Usage: find <text|placeholder|label|role> <value> [--name name] [-n count] [tabId]");
    }
    const limit = Number(firstOptionValue(rest, ["-n", "--limit"], 20));
    if (!Number.isFinite(limit) || limit < 1) throw new Error("Invalid find limit");
    const name = firstOptionValue(rest, ["--name"], "");
    const cleanRest = withoutOptions(rest, ["-n", "--limit", "--name"]);
    const tabIdArg = cleanRest.find((arg) => /^\d+$/.test(arg));
    const valueParts = cleanRest.filter((arg) => arg !== tabIdArg);
    const value = valueParts.join(" ");
    if (!value) throw new Error("Missing find value");
    const numericTabId = tabIdArg ? Number(tabIdArg) : loadSnapshotTabId();
    const result = await send({
      type: "eval",
      tabId: numericTabId,
      expression: findExpression(kind, value, { name, limit })
    });
    const snapshot = JSON.parse(result.result.value);
    if (numericTabId) snapshot.tabId = numericTabId;
    saveRefs(snapshot);
    printSnapshot(snapshot);
    return;
  }

  if (command === "wait") {
    const state = firstOptionValue(args, ["--state"], "visible");
    const cleanWaitArgs = withoutOptions(args, ["--state"]);
    const [mode, ...rest] = cleanWaitArgs;
    if (!mode) throw new Error("Missing wait target");

    if (/^\d+$/.test(mode)) {
      await new Promise((resolve) => setTimeout(resolve, Number(mode)));
      console.log(`waited ${mode}ms`);
      return;
    }

    if (mode === "--text") {
      const text = rest.join(" ");
      if (!text) throw new Error("Missing text");
      await waitUntil(async () => Boolean(await evalValue(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`, loadSnapshotTabId())));
      console.log(`found text: ${text}`);
      return;
    }

    if (mode === "--text-gone") {
      const text = rest.join(" ");
      if (!text) throw new Error("Missing text");
      await waitUntil(async () => !(await evalValue(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`, loadSnapshotTabId())));
      console.log(`text gone: ${text}`);
      return;
    }

    if (mode === "--url") {
      const [glob] = rest;
      if (!glob) throw new Error("Missing URL glob");
      const regex = globToRegExp(glob);
      await waitUntil(async () => regex.test(String(await evalValue("location.href", loadSnapshotTabId()))));
      console.log(`matched url: ${glob}`);
      return;
    }

    if (mode === "--fn") {
      const js = rest.join(" ");
      if (!js) throw new Error("Missing JS condition");
      await waitUntil(async () => Boolean(await evalValue(`Boolean(${js})`, loadSnapshotTabId())));
      console.log("condition matched");
      return;
    }

    if (mode === "--load") {
      const [wanted, tabIdArg] = rest;
      if (!["domcontentloaded", "load", "networkidle"].includes(wanted)) throw new Error("Usage: wait --load <domcontentloaded|load|networkidle>");
      const waitTabId = /^\d+$/.test(tabIdArg || "") ? Number(tabIdArg) : loadSnapshotTabId();
      if (wanted === "domcontentloaded") {
        await waitUntil(async () => ["interactive", "complete"].includes(String(await evalValue("document.readyState", waitTabId))));
      } else if (wanted === "load") {
        await waitUntil(async () => String(await evalValue("document.readyState", waitTabId)) === "complete");
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      console.log(`load state: ${wanted}`);
      return;
    }

    const { tabId, selector } = targetElement(mode);
    if (!["visible", "hidden", "detached"].includes(state)) throw new Error("Unsupported wait state");
    await waitUntil(async () => {
      if (state === "detached") {
        return Boolean(await evalValue(`!document.querySelector(${JSON.stringify(selector)})`, tabId));
      }
      if (state === "hidden") {
        return Boolean(await evalValue(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return true;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden';
        })()`, tabId));
      }
      return Boolean(await evalValue(stateExpression(selector, "visible"), tabId));
    });
    console.log(`${state}: ${mode}`);
    return;

    throw new Error(`Unsupported wait mode: ${mode}`);
    return;
  }

  if (command === "click") {
    const [target] = args;
    const point = await targetPoint(target);
    const payload = { type: "click", tabId: point.tabId, x: point.x, y: point.y };
    const confirmation = maybeRequireConfirmation("click", target, point, payload);
    if (confirmation) {
      console.log(JSON.stringify(confirmation, null, 2));
      return;
    }
    console.log(JSON.stringify(await send(payload), null, 2));
    return;
  }

  if (command === "dblclick") {
    const [target] = args;
    const point = await targetPoint(target);
    const payload = { type: "dblclick", tabId: point.tabId, x: point.x, y: point.y };
    const confirmation = maybeRequireConfirmation("dblclick", target, point, payload);
    if (confirmation) {
      console.log(JSON.stringify(confirmation, null, 2));
      return;
    }
    console.log(JSON.stringify(await send(payload), null, 2));
    return;
  }

  if (command === "hover") {
    const [target] = args;
    const point = await targetPoint(target);
    console.log(JSON.stringify(await send({ type: "hover", tabId: point.tabId, x: point.x, y: point.y }), null, 2));
    return;
  }

  if (command === "focus") {
    const [target] = args;
    const { tabId, selector } = targetElement(target);
    console.log(JSON.stringify(await send({
      type: "eval",
      tabId,
      expression: selectorExpression(selector, `(() => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        return { focused: document.activeElement === el };
      })()`)
    }), null, 2));
    return;
  }

  if (command === "fill") {
    const [target, ...textParts] = args;
    const text = textParts.join(" ");
    const { tabId, selector } = targetElement(target);
    await send({
      type: "eval",
      tabId,
      expression: selectorExpression(selector, `(() => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        if ('value' in el) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()`)
    });
    console.log(JSON.stringify(await send({ type: "type", tabId, text }), null, 2));
    return;
  }

  if (command === "type") {
    if (args.length === 0) throw new Error("Usage: type <selector|@ref> <text> OR type --active <text>");
    let tabId;
    let text;
    if (args[0] === "--active") {
      text = args.slice(1).join(" ");
      tabId = loadSnapshotTabId();
    } else if (args.length >= 2) {
      const [target, ...textParts] = args;
      text = textParts.join(" ");
      const resolved = targetElement(target);
      tabId = resolved.tabId;
      await send({
        type: "eval",
        tabId,
        expression: selectorExpression(resolved.selector, `(() => {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.focus();
          return true;
        })()`)
      });
    } else {
      text = args[0];
      tabId = loadSnapshotTabId();
    }
    console.log(JSON.stringify(await send({ type: "type", tabId, text }), null, 2));
    return;
  }

  if (command === "keyboard") {
    const [subcommand, ...textParts] = args;
    const text = textParts.join(" ");
    const tabId = loadSnapshotTabId();
    if (subcommand === "type") {
      console.log(JSON.stringify(await send({ type: "keyboard-type", tabId, text }), null, 2));
      return;
    }
    if (subcommand === "inserttext" || subcommand === "insertText") {
      console.log(JSON.stringify(await send({ type: "insert-text", tabId, text }), null, 2));
      return;
    }
    throw new Error("Usage: keyboard <type|inserttext> <text>");
  }

  if (command === "upload") {
    const [target, ...files] = args;
    if (!target || files.length === 0) throw new Error("Usage: upload <selector|@ref> <file...>");
    let tabId;
    let selector = target;
    let backendDOMNodeId;
    if (isRef(target)) {
      const resolved = targetElement(target);
      tabId = resolved.tabId;
      selector = resolved.selector;
      backendDOMNodeId = resolved.backendDOMNodeId;
    } else {
      tabId = loadSnapshotTabId();
    }
    const absoluteFiles = files.map((file) => {
      const absolute = path.resolve(file);
      if (!fs.existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
      return absolute;
    });
    console.log(JSON.stringify(await send({ type: "upload", tabId, selector, backendDOMNodeId, files: absoluteFiles }), null, 2));
    return;
  }

  if (command === "check" || command === "uncheck") {
    const [target] = args;
    const checked = command === "check";
    const { tabId, selector } = targetElement(target);
    console.log(JSON.stringify(await send({
      type: "eval",
      tabId,
      expression: selectorExpression(selector, `(() => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const desired = ${checked};
        const role = el.getAttribute('role');
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
          if (el.checked !== desired) el.click();
          return { checked: el.checked };
        }
        if (role === 'checkbox') {
          const current = el.getAttribute('aria-checked') === 'true';
          if (current !== desired) el.click();
          return { checked: el.getAttribute('aria-checked') === 'true' };
        }
        if ('checked' in el) {
          el.checked = desired;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { checked: el.checked };
        }
        throw new Error('Target is not checkable');
      })()`)
    }), null, 2));
    return;
  }

  if (command === "select") {
    const [target, ...valueParts] = args;
    const valueOrLabel = valueParts.join(" ");
    if (!target || !valueOrLabel) throw new Error("Usage: select <selector|@ref> <value-or-label>");
    const { tabId, selector } = targetElement(target);
    console.log(JSON.stringify(await send({
      type: "eval",
      tabId,
      expression: selectorExpression(selector, `(() => {
        if (!(el instanceof HTMLSelectElement)) throw new Error('Target is not a select element');
        const wanted = ${JSON.stringify(valueOrLabel)};
        const option = [...el.options].find((item) => item.value === wanted || item.label === wanted || item.textContent.trim() === wanted);
        if (!option) throw new Error('Option not found: ' + wanted);
        el.value = option.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: el.value, label: option.textContent.trim() };
      })()`)
    }), null, 2));
    return;
  }

  if (command === "scroll") {
    const [mode, amountArg] = args;
    if (!mode) throw new Error("Usage: scroll <up|down|left|right|top|bottom|selector|@ref> [pixels]");
    if (["up", "down", "left", "right"].includes(mode)) {
      const amount = Number(amountArg || 700);
      const delta = {
        up: { x: 0, y: -amount },
        down: { x: 0, y: amount },
        left: { x: -amount, y: 0 },
        right: { x: amount, y: 0 }
      }[mode];
      console.log(JSON.stringify(await send({
        type: "eval",
        tabId: loadSnapshotTabId(),
        expression: `(() => {
          window.scrollBy({ left: ${delta.x}, top: ${delta.y}, behavior: 'instant' });
          return { x: window.scrollX, y: window.scrollY };
        })()`
      }), null, 2));
      return;
    }
    if (mode === "top" || mode === "bottom") {
      console.log(JSON.stringify(await send({
        type: "eval",
        tabId: loadSnapshotTabId(),
        expression: `(() => {
          window.scrollTo({ left: 0, top: ${mode === "top" ? 0 : "document.documentElement.scrollHeight"}, behavior: 'instant' });
          return { x: window.scrollX, y: window.scrollY };
        })()`
      }), null, 2));
      return;
    }
    const { tabId, selector } = targetElement(mode);
    console.log(JSON.stringify(await send({
      type: "eval",
      tabId,
      expression: selectorExpression(selector, `(() => {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return { x: window.scrollX, y: window.scrollY };
      })()`)
    }), null, 2));
    return;
  }

  if (command === "scrollintoview") {
    const [target] = args;
    if (!target) throw new Error("Usage: scrollintoview <selector|@ref>");
    const { tabId, selector } = targetElement(target);
    console.log(JSON.stringify(await send({
      type: "eval",
      tabId,
      expression: selectorExpression(selector, `(() => {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        return {
          x: window.scrollX,
          y: window.scrollY,
          centerX: Math.round(rect.left + rect.width / 2),
          centerY: Math.round(rect.top + rect.height / 2)
        };
      })()`)
    }), null, 2));
    return;
  }

  if (command === "press") {
    const [key] = args;
    if (!key) throw new Error("Missing key");
    const tabId = loadSnapshotTabId();
    console.log(JSON.stringify(await send({ type: "press", tabId, key }), null, 2));
    return;
  }

  if (command === "mouse") {
    const [action, ...rest] = args;
    const tabId = loadSnapshotTabId();
    if (action === "move") {
      const [x, y] = rest.map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Usage: mouse move <x> <y>");
      console.log(JSON.stringify(await send({ type: "mouse", tabId, action, x, y }), null, 2));
      return;
    }
    if (action === "down" || action === "up") {
      const [xArg, yArg, button = "left"] = rest;
      const x = Number(xArg);
      const y = Number(yArg);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Usage: mouse ${action} <x> <y> [button]`);
      console.log(JSON.stringify(await send({ type: "mouse", tabId, action, x, y, button }), null, 2));
      return;
    }
    if (action === "wheel") {
      const [deltaYArg, deltaXArg = "0"] = rest;
      const deltaY = Number(deltaYArg);
      const deltaX = Number(deltaXArg);
      if (!Number.isFinite(deltaY) || !Number.isFinite(deltaX)) throw new Error("Usage: mouse wheel <deltaY> [deltaX]");
      console.log(JSON.stringify(await send({ type: "mouse", tabId, action, deltaY, deltaX }), null, 2));
      return;
    }
    throw new Error("Usage: mouse <move|down|up|wheel> ...");
  }

  if (command === "eval") {
    const limitValue = firstOptionValue(args, ["--limit", "-l"], null);
    const limit = limitValue === null ? null : Number(limitValue);
    const cleanArgs = withoutOptions(args, ["--limit", "-l"], ["--stdin"]);
    let js;
    if (args.includes("--stdin")) {
      js = await readStdin();
    } else {
      js = cleanArgs[0];
    }
    const tabId = args.includes("--stdin")
      ? cleanArgs.find((arg) => /^\d+$/.test(arg))
      : cleanArgs.find((arg, index) => index > 0 && /^\d+$/.test(arg));
    if (!js) throw new Error("Missing JS");
    const result = await send({ type: "eval", tabId: tabId ? Number(tabId) : loadSnapshotTabId(), expression: js });
    if (limit !== null) {
      printLimited(result, limit);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  if (command === "screenshot") {
    const annotate = args.includes("--annotate");
    const cleanArgs = withoutOptions(args, [], ["--annotate"]);
    const [outPath, tabId] = cleanArgs;
    if (!outPath) throw new Error("Missing output path");
    const numericTabId = tabId ? Number(tabId) : loadSnapshotTabId();
    if (annotate) {
      const snapshot = (() => {
        try {
          return loadRefs();
        } catch {
          return { elements: [] };
        }
      })();
      const labels = (snapshot.elements || []).slice(0, 40).map((element) => ({
        ref: element.ref,
        x: element.x,
        y: element.y
      })).filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
      await send({
        type: "eval",
        tabId: numericTabId,
        expression: `(() => {
          document.getElementById("__my_browser_overlay__")?.remove();
          const root = document.createElement("div");
          root.id = "__my_browser_overlay__";
          root.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:12px system-ui,sans-serif";
          for (const item of ${JSON.stringify(labels)}) {
            const label = document.createElement("div");
            label.textContent = item.ref;
            label.style.cssText = "position:absolute;left:" + Math.max(0, item.x - 10) + "px;top:" + Math.max(0, item.y - 10) + "px;background:#6d4aff;color:white;border:1px solid white;border-radius:999px;padding:2px 5px;box-shadow:0 1px 4px rgba(0,0,0,.35)";
            root.appendChild(label);
          }
          document.documentElement.appendChild(root);
          return { annotated: ${labels.length} };
        })()`
      });
    }
    const result = await send({ type: "screenshot", tabId: numericTabId });
    fs.writeFileSync(outPath, Buffer.from(result.data, "base64"));
    if (annotate) {
      await send({
        type: "eval",
        tabId: numericTabId,
        expression: `document.getElementById("__my_browser_overlay__")?.remove(); true`
      }).catch(() => null);
    }
    console.log(outPath);
    return;
  }

  if (command === "console" || command === "errors" || command === "requests") {
    const clear = args.includes("--clear");
    const result = await send({ type: "events", kind: command, clear }).catch((error) => ({
      ok: false,
      error: String(error?.message ?? error),
      advice: "Reload the Local Browser Operator Lab extension so the v2 background operator is active."
    }));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "confirm" || command === "deny") {
    const [id] = args;
    if (!id) throw new Error(`Usage: ${command} <id>`);
    const confirmations = loadConfirmations();
    const item = confirmations[id];
    if (!item) throw new Error(`Confirmation not found: ${id}`);
    delete confirmations[id];
    saveConfirmations(confirmations);
    if (command === "deny") {
      console.log(JSON.stringify({ denied: true, id }, null, 2));
      return;
    }
    console.log(JSON.stringify(await replayConfirmed(item.action), null, 2));
    return;
  }

  if (command === "detach") {
    console.log(JSON.stringify(await send({ type: "detach" }), null, 2));
    return;
  }

  usage();
  process.exit(1);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
