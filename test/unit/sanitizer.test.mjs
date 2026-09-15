// test/unit/sanitizer.test.mjs —— 日志脱敏模块单元测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, maskToken, sanitizePath, stripControlSequences } from '../../sanitizer.js';

// ---- stripControlSequences ----

test('stripControlSequences: 清除 ANSI 转义序列', () => {
  assert.equal(stripControlSequences('\x1b[32mPASS\x1b[0m'), 'PASS');
  assert.equal(stripControlSequences('\x1b[1;31mERROR\x1b[0m'), 'ERROR');
  assert.equal(stripControlSequences('no escapes'), 'no escapes');
});

test('stripControlSequences: 清除控制字符', () => {
  assert.equal(stripControlSequences('hello\x00world'), 'helloworld');
  assert.equal(stripControlSequences('line\x08back'), 'lineback');
});

test('stripControlSequences: 非字符串返回空', () => {
  assert.equal(stripControlSequences(null), '');
  assert.equal(stripControlSequences(undefined), '');
  assert.equal(stripControlSequences(123), '');
});

// ---- maskToken ----

test('maskToken: 遮蔽长 token', () => {
  assert.equal(maskToken('sk-abc123def456ghi789'), 'sk-a****i789');
});

test('maskToken: 短 token 全部遮蔽', () => {
  assert.equal(maskToken('short'), '***');
  assert.equal(maskToken('12345678901'), '***'); // 11 chars
});

test('maskToken: 空/null 返回 ***', () => {
  assert.equal(maskToken(''), '***');
  assert.equal(maskToken(null), '***');
  assert.equal(maskToken(undefined), '***');
});

test('maskToken: 正好 12 字符显示首尾', () => {
  assert.equal(maskToken('123456789012'), '1234****9012');
});

// ---- sanitizePath ----

test('sanitizePath: 替换 macOS 用户目录', () => {
  assert.equal(sanitizePath('/Users/raylee/code/test'), '<home>/code/test');
});

test('sanitizePath: 替换 Linux 用户目录', () => {
  assert.equal(sanitizePath('/home/user/projects'), '<home>/projects');
});

test('sanitizePath: 替换 /tmp/', () => {
  assert.equal(sanitizePath('/tmp/test-file'), '<tmp>/test-file');
});

test('sanitizePath: 替换 /var/', () => {
  assert.equal(sanitizePath('/var/log/test'), '<var>/log/test');
});

test('sanitizePath: 替换 Windows 路径', () => {
  assert.equal(sanitizePath('C:\\Users\\admin\\file'), '<home>\\file');
  assert.equal(sanitizePath('C:\\Windows\\System32'), '<windows>\\System32');
  assert.equal(sanitizePath('C:\\Program Files\\app'), '<program-files>\\app');
});

test('sanitizePath: 非字符串返回空', () => {
  assert.equal(sanitizePath(null), '');
  assert.equal(sanitizePath(undefined), '');
});

// ---- sanitize (集成测试) ----

test('sanitize: 清除 OpenAI API key', () => {
  assert.equal(sanitize('key=sk-abc123def456ghi789jkl'), 'key=***');
  assert.equal(sanitize('api-key=sk_test_abcdefghijklmnop'), 'api-key=***');
});

test('sanitize: 清除 GitHub token', () => {
  assert.equal(sanitize('ghp_abcdefghij1234567890abcdef'), '***');
  assert.equal(sanitize('gho_abcdefghij1234567890abcdef'), '***');
  assert.equal(sanitize('github_pat_abcdefghij1234567890abcdef'), '***');
});

test('sanitize: 清除 JWT token', () => {
  assert.equal(sanitize('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789jkl'), '***');
});

test('sanitize: 清除私钥', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIB...data...\n-----END RSA PRIVATE KEY-----';
  assert.equal(sanitize(key), '***');
});

test('sanitize: 清除 Bearer token', () => {
  assert.equal(sanitize('Authorization: Bearer abcdefghij1234567890abcdef'), 'Authorization: Bearer ***');
});

test('sanitize: 清除环境变量中的 secret', () => {
  assert.equal(sanitize('SECRET_KEY=supersecretvalue123'), 'SECRET_KEY=***');
  assert.equal(sanitize('password = mysecretpass'), 'password = ***');
});

test('sanitize: 清除 AWS 凭证', () => {
  assert.equal(sanitize('AKIAIOSFODNN7EXAMPLE'), '***');
  assert.equal(sanitize('AWS_SESSION_TOKEN=faketoken123'), '***');
});

test('sanitize: 清除 Anthropic API key', () => {
  assert.equal(sanitize('sk-ant-abcdefghij1234567890abcdef'), '***');
});

test('sanitize: 清除 URL 中的密码', () => {
  assert.equal(sanitize('https://user:password123@example.com'), 'https://user:***@example.com');
});

test('sanitize: 清除 Basic auth', () => {
  assert.equal(sanitize('Basic dXNlcjpwYXNz'), 'Basic ***');
});

test('sanitize: 保留普通文本', () => {
  assert.equal(sanitize('hello world'), 'hello world');
  assert.equal(sanitize('no secrets here'), 'no secrets here');
});

test('sanitize: 非字符串返回空', () => {
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(123), '');
});


// ---- sanitize: 灾难性回溯防护 ----
//
// 回归护栏。密钥赋值模式曾写成 [A-Za-z_]*(key|secret|…)[A-Za-z_]*，前后两个 Kleene
// star 与中间的 alternation 字符集完全重叠，导致每个起始位置都要穷举切分点。
// 实测退化为 O(n³)：200→2.4ms、400→14ms、800→114ms、1600→897ms。
// sanitize() 是同步的，一次触发即冻结整个网关的事件循环——连 node:test 的
// { timeout } 都无法中断它，所以这里用绝对耗时而非测试超时来守。

test('sanitize: 对抗性赋值串不触发灾难性回溯', () => {
  const hostile = 'A_KEY'.repeat(320);           // 1600 字符，全部命中敏感词前后缀
  const started = performance.now();
  sanitize(hostile);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `1600 字符对抗输入应在 200ms 内完成，实际 ${elapsed.toFixed(0)}ms`);
});

test('sanitize: 耗时随输入规模线性增长', () => {
  const measure = size => {
    const started = performance.now();
    sanitize('A_KEY'.repeat(size / 5));
    return performance.now() - started;
  };
  measure(400);                                   // 预热，避开 JIT 冷启动
  const small = Math.max(measure(400), 0.05);
  const large = measure(1600);                    // 4 倍输入
  assert.ok(large / small < 20, `4 倍输入的耗时比应远小于 20（线性约为 4），实际 ${(large / small).toFixed(1)}`);
});

test('sanitize: 长串无敏感词时不回溯', () => {
  const started = performance.now();
  sanitize('-----BEGIN RSA PRIVATE KEY-----' + 'x'.repeat(100000));   // 有 BEGIN 无 END
  assert.ok(performance.now() - started < 200);
});

// ---- 脱敏覆盖面：回归护栏 ----
//
// 这些形式在把嵌套量词换成「匹配标识符 + 回调判定」时全部漏过了。根因有两个：
// 值用 \S+ 匹配会吃掉整个非空白串，replace 的 lastIndex 随之跨过后面的敏感赋值；
// 标识符起锚要求首字符是字母或下划线，数字开头的名字锚不上。

test('sanitize: 敏感赋值紧邻在非敏感赋值之后仍被遮蔽', () => {
  const secret = 'deadbeefdeadbeefdeadbeefdeadbeef';
  for (const input of [
    `curl 'https://api.vendor.com/run?project=demo&secret=${secret}'`,
    `DSN=postgres://x;password=${secret}`,
    `a=b,secret=${secret}`,
    `user=root;password=${secret}`,
    `X-Req=1|api_key=${secret}`,
    `foo=1&client_secret=${secret}`,
  ]) {
    assert.ok(!sanitize(input).includes(secret), `未遮蔽：${input}`);
  }
});

test('sanitize: 数字开头与含数字的标识符同样被遮蔽', () => {
  const secret = 'deadbeefdeadbeefdeadbeefdeadbeef';
  assert.ok(!sanitize(`2FA_TOKEN=${secret}`).includes(secret));
  assert.ok(!sanitize(`403_secret=${secret}`).includes(secret));
  assert.equal(sanitize('S3_KEY=abc'), 'S3_KEY=***');
  assert.equal(sanitize('K8S_SECRET=q'), 'K8S_SECRET=***');
});

test('sanitize: 超长标识符不会因长度上限而漏掉', () => {
  const secret = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const longName = `${'A_'.repeat(90)}SECRET`;   // 远超 128 字符
  assert.ok(!sanitize(`${longName}=${secret}`).includes(secret));
});

test('sanitize: 普通赋值不被误伤', () => {
  assert.equal(sanitize('foo=bar'), 'foo=bar');
  assert.equal(sanitize('count=42&page=3'), 'count=42&page=3');
  assert.equal(sanitize('hello world'), 'hello world');
});

// ---- 变异补漏：批 5（AUDIT） ----

// 8 是「小写标识符的赋值要多长才算敏感」的分界线。注释写明了它的用意：
// 短的（foo=bar）不误伤，长的（apikey=abcdefgh）要打码。分界线判反的方向不对称——
// 往松了判会把真凭证放出去，往紧了判只是多打几个码，所以边界必须钉死在「>= 8」。
test('小写敏感标识符的赋值以 8 个字符为界，边界值算敏感', () => {
  assert.equal(sanitize('apikey=abcdefgh'), 'apikey=***', '正好 8 个字符：必须打码');
  assert.equal(sanitize('apikey=abcdefghi'), 'apikey=***', '超过 8 个：必须打码');
  assert.equal(sanitize('apikey=abcdefg'), 'apikey=abcdefg', '只有 7 个：按注释说的不误伤');

  // 全大写（环境变量风格）不受长度限制。
  assert.equal(sanitize('API_KEY=short'), 'API_KEY=***');
  assert.equal(sanitize('S3_KEY=a'), 'S3_KEY=***');
  // 名字里不含敏感词的一律不动。
  assert.equal(sanitize('width=1234567890'), 'width=1234567890');
});

// maskToken 的两条早退都返回 '***'。判反的话，空串或非字符串会掉进下面的 slice，
// 结果是把一个不该出现的东西（比如 undefined 的字面量）拼进日志。
test('maskToken 对空值与非字符串一律给 ***，不掉进 slice', () => {
  for (const value of ['', null, undefined, 0, 123456789012, {}, []]) {
    assert.equal(maskToken(value), '***', `${String(value)} 不该走进 slice`);
  }
  assert.equal(maskToken('short'), '***', '太短的也只给 ***');
  assert.equal(maskToken('abcdefghijkl'), 'abcd****ijkl', '12 个字符正好是下限，可以露头尾');
});
