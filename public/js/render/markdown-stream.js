/**
 * 把流式 markdown 切成「已定型的前缀」和「还在变的尾部」。
 *
 * 用途是增量渲染：stable 渲染成 DOM 之后不再重建，每帧只重渲染 active。
 * 不这么做的话，onText 每 40ms 要把整段文本重新 parse + sanitize + highlight,
 * 成本随已生成长度线性增长，长回复必卡。
 */
/** 取一行开头的围栏标记（``` 或 ~~~，允许最多 3 空格缩进），没有则返回 ''。 */
function fenceMarker(line) {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return match ? match[1] : '';
}

/**
 * 这一行是否可能是上一个块的延续（列表项、引用、缩进续行）。
 * 用来识别「空行夹在同一个块内部」——那种空行不是安全切点。
 *
 * 「可能」不是含糊其辞。流式文本的最后一行随时会变长：`-` 下一帧就是 `- 甲`,
 * `1` 下一帧就是 `1.`。若按当前形态判成非延续而切开，下一帧判定翻转、切点
 * 回退，已经画好的 stable DOM 就和文本对不上。所以只有标记、还没跟内容的
 * 半截行一律保守算延续 —— 代价是晚一帧进 stable，换来单调性。
 */
function isBlockContinuation(line) {
  return /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line)
    || /^\s*\d{1,9}$/.test(line)
    || /^ {0,3}>/.test(line)
    || /^(?: {4}|\t)/.test(line);
}

export function splitStreamingMarkdown(raw) {
  const text = String(raw ?? '');
  const lines = text.split('\n');
  let fence = '';            // 当前开启的围栏标记，'' 表示不在围栏内
  let offset = 0;            // 当前行首在 text 中的字符索引
  let cut = 0;               // 最后一个已确认的安全切点
  let pendingCut = -1;       // 候选切点，等下一个非空行到达才能判定
  let prevNonEmpty = '';

  for (const line of lines) {
    const next = offset + line.length + 1; // +1 补回 split 掉的 '\n'
    const marker = fenceMarker(line);

    if (line.trim() === '') {
      // 围栏内的空行是代码的一部分，不是块分隔符。
      if (!fence) pendingCut = next;
    } else {
      // 候选切点要等到这一刻才能判定：空行两侧都是列表/引用延续时，
      // 说明它夹在同一个块内部，切开会改变 marked 的松散/紧凑判定。
      if (pendingCut >= 0 && !(isBlockContinuation(prevNonEmpty) && isBlockContinuation(line))) {
        cut = pendingCut;
      }
      pendingCut = -1;
      prevNonEmpty = line;

      if (fence) {
        // 闭合围栏要同字符且不短于开启标记，否则 ``` 收不掉 ~~~~。
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      } else if (marker) {
        fence = marker;
      }
    }

    offset = next;
  }

  return { stable: text.slice(0, cut), active: text.slice(cut) };
}
