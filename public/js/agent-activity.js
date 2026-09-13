// 工具活动的文案模型。抄自 ChatGPT 桌面端的 localConversation.agentActivity.*：
// 同一条活动在进行中和完成后用两套时态，进行中回答「现在在做什么」，完成后回答
// 「刚才做过什么」。两者不共用字符串——「运行命令」既不是正在运行也不是运行过。

// 完成后的说法分句首（leading）和句中两版。英文那边分版是为了首字母大小写，中文
// 没有大小写，但 zh-CN 包仍给了两套——读取文件是「已读取文件」/「读取文件」，
// 句首带「已」把整句的时态定下来，句中再带就啰嗦。
const SUMMARY_LABELS = {
  search: { leading: () => '已搜索网页', inline: () => '已搜索网页' },
  command: { leading: () => '运行了命令', inline: () => '运行了命令' },
  'file-change': {
    leading: n => (n === 1 ? '编辑了一个文件' : '编辑了文件'),
    inline: n => (n === 1 ? '编辑了一个文件' : '编辑了多个文件'),
  },
  read: { leading: () => '已读取文件', inline: () => '读取文件' },
  mcp: {
    leading: n => (n === 1 ? '调用了一个工具' : '调用了工具'),
    inline: n => (n === 1 ? '调用了一个工具' : '调用了工具'),
  },
};

export function summarizeActivities(activities = []) {
  // 按首次出现顺序归并：读者是顺着时间看下来的，摘要跟着同一条时间线才对得上。
  const order = [];
  const counts = new Map();
  for (const activity of activities) {
    const type = activity?.type;
    if (!SUMMARY_LABELS[type]) continue;
    if (!counts.has(type)) order.push(type);
    counts.set(type, (counts.get(type) || 0) + (Number(activity.count) || 1));
  }
  return order
    .map((type, index) => SUMMARY_LABELS[type][index === 0 ? 'leading' : 'inline'](counts.get(type)))
    .join('、');
}

// 中英之间加不加空格，zh-CN 包本身就不统一（「4秒」不带、「2 分钟」带）。原样照抄，
// 自己统一一套只会和 ChatGPT 的截图对不上，而这里的目标就是对得上。
function formatDuration(ms) {
  const totalSeconds = Math.round(Math.max(0, Number(ms) || 0) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds ? `${totalMinutes}分 ${seconds} 秒` : `${totalMinutes} 分钟`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} 小时 ${minutes} 分` : `${hours}小时`;
}

// 折叠一组活动时的标题。整组是同一个工具的话，按类型归并会把最有用的信息
// （哪个工具、调了几次）丢掉，这时改用计数说法。
export function groupSummary(activities = []) {
  const labels = activities.map(a => a?.label).filter(Boolean);
  if (activities.length > 1 && labels.length === activities.length
    && labels.every(label => label === labels[0])) {
    return repeatedCallsLabel(labels[0], activities.length);
  }
  return summarizeActivities(activities);
}

export function workedForLabel(ms) {
  return `用时 ${formatDuration(ms)}`;
}

// 思考块的完成态。量不到耗时（历史回放、秒回）时退回不带数字的说法，而不是
// 报一个「已思考 0秒」——那读起来像没思考。
export function thoughtLabel(ms) {
  return Number(ms) > 0 ? `已思考 ${formatDuration(ms)}` : '已完成思考';
}

export function repeatedCallsLabel(toolName, count) {
  return `${toolName} · ${count} 次调用`;
}

export function activeLabel(activity = {}) {
  switch (activity.type) {
    case 'command':
      return activity.command ? `正在运行 ${activity.command}` : '正在运行命令';
    case 'search':
      return activity.query ? `正在网络上搜索 ${activity.query}` : '正在搜索网页';
    case 'file-change':
      return '正在编辑文件';
    case 'mcp':
      return `${activity.serverName}/${activity.toolName}`;
    default:
      return '';
  }
}
