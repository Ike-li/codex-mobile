// 斜杠命令的解析与分发表。
//
// codex 的 slash command 整套住在 TUI 层（二进制里只有 codex_tui::slash_command，
// core 和 app-server 没有任何 slash 符号），app-server 的 turn/start 只收 UserInput
// 内容，没有 command 字段。所以「把 /compact 发过去让 codex 自己解析」是死路——
// TUI 自己也只是个 app-server 客户端，它的 /compact 就是一次 thread/compact/start。
//
// 本文件做的就是 TUI 那张映射表的移动端版本：文本 → 意图。意图落到哪个函数由
// app.js 绑定，这里保持纯数据，方便单测。

// 相对路径而不是 /js/：浏览器里解析结果一样，但 node 单测也能直接加载。
// 项目里用 /js/ 绝对导入的模块（workspace-panel.js）都只有 e2e 覆盖。
import { parseCollaborationModeSlash } from '../util/cli-settings.js';

// 命令词形态：开头一个词，不含第二个斜杠。收紧到这个程度是为了不误伤正常消息——
// `/usr/bin/codex 这个路径不对` 和 `/etc/hosts` 都得当普通文本发出去。
// 第二个捕获组是参数，只有 acceptsArgs 的命令认它，其余带参数就当普通消息。
const COMMAND_WORD = /^\/([A-Za-z][A-Za-z0-9-]*)(?:\s+([\s\S]+))?$/;

// 已接入的命令。action 是给 app.js 查表用的 id，desc / iconName 喂给 /help 和挑选层。
export const SLASH_ACTIONS = {
  '/help': { action: 'help', desc: '列出手机端可用的命令', iconName: 'compass' },
  '/status': { action: 'session-settings', desc: '查看本会话的模型、权限和推理强度', iconName: 'chart' },
  '/model': { action: 'session-settings', desc: '切换模型与推理强度', iconName: 'bot' },
  '/permissions': { action: 'session-settings', desc: '查看或修改审批与沙箱', iconName: 'shield' },
  '/diff': { action: 'diff', desc: '打开工作区改动面板', iconName: 'search' },
  // 唯一收参数的命令：无参数审未提交改动，有参数当自定义审查指令。
  '/review': { action: 'review', desc: '审查未提交改动；跟一句话则按该指令审查', acceptsArgs: true, iconName: 'notepad' },
  '/compact': { action: 'compact', desc: '压缩上下文以释放 token', iconName: 'broom' },
  '/new': { action: 'new-session', desc: '在当前目录新建会话', iconName: 'plus' },
  '/files': { action: 'files', desc: '浏览工作区文件', iconName: 'folder' },
  '/mcp': { action: 'mcp', desc: '查看已配置的 MCP 服务', iconName: 'tools' },
  '/skills': { action: 'skills', desc: '查看已加载的 skills', iconName: 'star' },
  '/usage': { action: 'account', desc: '查看账号用量与速率限制', iconName: 'receipt' },
};

// codex 里有、手机端按不下去的命令。原因要具体到「改用什么」，
// 否则用户只知道不能用，不知道下一步往哪走。
export const UNSUPPORTED_SLASH = {
  '/init': '手机端还没接入，先在 CLI 里跑',
  '/goal': '手机端还没接入 thread/goal',
  '/feedback': '手机端还没接入 feedback/upload',
  '/mention': '手机端用 @ 触发文件补全，不走斜杠',
  '/resume': '在会话抽屉里选会话',
  '/fork': '在会话抽屉里对目标会话操作',
  '/archive': '在会话抽屉里对目标会话操作',
  '/delete': '在会话抽屉里对目标会话操作',
  '/rename': '在会话抽屉里对目标会话操作',
  '/cd': '在目录抽屉里切换工作目录',
  '/plan': '当前连接还不能切换计划模式',
  '/logout': '在设置面板的账号一栏退出',
  '/vim': '终端专属，手机端没有对应物',
  '/clear': '终端专属，手机端没有对应物',
  '/copy': '终端专属，手机端没有对应物',
  '/export': '终端专属，手机端没有对应物',
  '/raw': '终端专属，手机端没有对应物',
  '/pets': '终端专属，手机端没有对应物',
  '/quit': '终端专属，手机端没有对应物',
  '/exit': '终端专属，手机端没有对应物',
};

export function resolveSlashCommand(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw.startsWith('/')) return null;

  // /chat 后面可以直接跟消息。/plan 在协议接通前走 unsupported，不进挑选层。
  const modeSlash = parseCollaborationModeSlash(raw);
  if (modeSlash?.mode === 'default') {
    return { kind: 'mode', cmd: '/chat', mode: 'default', rest: modeSlash.rest };
  }

  const match = raw.match(COMMAND_WORD);
  if (!match) return null;

  // 只有命令名大小写不敏感。参数原样交出去——审查指令是给模型读的。
  const cmd = `/${match[1].toLowerCase()}`;
  const args = match[2] || '';
  const entry = SLASH_ACTIONS[cmd];
  if (entry) {
    // 不收参数的命令带了参数，说明用户在写一句以斜杠开头的话，照旧当普通消息。
    if (args && !entry.acceptsArgs) return null;
    return { kind: 'action', cmd, action: entry.action, args };
  }
  if (args) return null;
  if (cmd in UNSUPPORTED_SLASH) return { kind: 'unsupported', cmd, reason: UNSUPPORTED_SLASH[cmd] };
  return { kind: 'unknown', cmd };
}

export function slashHelpLines() {
  return Object.entries(SLASH_ACTIONS).map(([cmd, { desc }]) => `${cmd} — ${desc}`);
}

export function slashPickerItems() {
  return Object.entries(SLASH_ACTIONS).map(([cmd, { desc, iconName }]) => ({
    cmd,
    desc,
    iconName: iconName || 'compass',
  }));
}
