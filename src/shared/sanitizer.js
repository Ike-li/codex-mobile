// sanitizer.js —— 日志脱敏模块
// 功能：过滤日志/终端输出中的敏感信息（token、API key、密码等），防止泄露。

// 敏感赋值：先把标识符整体匹配一次，再在回调里判定是否敏感。
// 不要写成 [A-Za-z_]*(key|secret|…)[A-Za-z_]* —— 前后两个 Kleene star 与中间
// alternation 的字符集完全重叠，每个起始位置都要穷举切分点，实测退化到 O(n³)。
//
// 值必须停在分隔符处。用 \S+ 会吃掉整个非空白串，replace 的 lastIndex 随之跨过
// 后面的敏感赋值——project=demo&secret=… 里的 secret 就是这样整条漏出去的。
// 起锚用负向后顾而不是 \b，首字符允许数字（2FA_TOKEN=…），标识符不设长度上限。
const SENSITIVE_ASSIGNMENT_RE = /(?<![A-Za-z0-9_])([A-Za-z0-9_]+)(\s*=\s*)([^\s;,&|]+)/g;
const SENSITIVE_NAME_RE = /key|secret|token|password|passwd|credential/i;

function redactAssignment(match, name, separator, value) {
  if (!SENSITIVE_NAME_RE.test(name)) return match;
  // 全大写标识符（环境变量风格，含数字如 S3_KEY / OAUTH2_TOKEN）不限 value 长度；其余要求 value 至少 8 字符，
  // 避免把 foo=bar 这类普通赋值误伤。
  if (/^[A-Z0-9_]+$/.test(name) || value.length >= 8) return `${name}${separator}***`;
  return match;
}

const PATTERNS = [
  [/\b(sk|key|api)[-_][A-Za-z0-9][A-Za-z0-9_-]{15,}\b/g, '***'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***'],
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, '***'],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer ***'],
  [SENSITIVE_ASSIGNMENT_RE, redactAssignment],
  [/\b(aws_session_token|AWS_SESSION_TOKEN)\s*=\s*\S+/gi, '***'],
  [/\b(access_token|refresh_token)[:=]\s*[A-Za-z0-9._-]{20,}\b/g, '$1:***'],
  [/\b[0-9a-f]{2}(:[0-9a-f]{2}){15,}\b/g, '***'],
  [/\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/g, '$1***$2'],
  [/(?:Basic\s+)[A-Za-z0-9+/=]{8,}/gi, 'Basic ***'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '***'],
  [/\b(bot)?\d{6,}(?::|%3[Aa])[A-Za-z0-9_-]{20,}\b/g, '***'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '***'],
];

// eslint-disable-next-line no-control-regex -- 剥离 ANSI 转义序列必须匹配控制字符
const ANSI_ESCAPE_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex -- 剥离终端控制字符是本模块职责
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripControlSequences(text) {
  if (typeof text !== 'string') return '';
  text = text.replace(ANSI_ESCAPE_RE, '');
  text = text.replace(CONTROL_CHARS_RE, '');
  return text;
}

export function sanitize(text) {
  if (typeof text !== 'string') return '';
  text = stripControlSequences(text);
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function maskToken(token) {
  if (!token || typeof token !== 'string') return '***';
  if (token.length < 12) return '***';
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

export function sanitizePath(path) {
  if (typeof path !== 'string') return '';
  const replacements = [
    [/\/Users\/[^/]+/g, '<home>'],
    [/\/home\/[^/]+/g, '<home>'],
    [/C:\\Users\\[^\\]+/gi, '<home>'],
    [/\/tmp\//g, '<tmp>/'],
    [/\/var\//g, '<var>/'],
    [/C:\\Windows\\/gi, '<windows>\\'],
    [/C:\\Program Files/gi, '<program-files>'],
  ];
  for (const [pattern, replacement] of replacements) {
    path = path.replace(pattern, replacement);
  }
  return path;
}
