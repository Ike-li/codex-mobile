# 第三方组件与许可证 / Third-Party Notices

本目录（`public/vendor/`）打包并随项目分发以下第三方组件。它们各自的版权与许可证如下。
项目自身代码以 AGPL-3.0-only 许可（见仓库根 `LICENSE`），不改变下列组件的许可。

## marked — `marked.min.js`

- 版本 / Version: 12.0.2
- 版权 / Copyright: © 2011–2024 Christopher Jeffrey and contributors
- 许可 / License: MIT (SPDX: `MIT`)
- 来源 / Source: https://github.com/markedjs/marked

## DOMPurify — `purify.min.js`

- 版本 / Version: 3.4.10
- 版权 / Copyright: © Cure53 and other contributors
- 许可 / License: Apache-2.0 OR MPL-2.0
- 许可全文 / Full text: https://github.com/cure53/DOMPurify/blob/3.4.10/LICENSE
- 来源 / Source: https://github.com/cure53/DOMPurify

## highlight.js — `highlight.min.js`

- 版本 / Version: 11.11.1
- 版权 / Copyright: © 2006–2024 Josh Goebel and other contributors
- 许可 / License: BSD-3-Clause (SPDX: `BSD-3-Clause`)
- 来源 / Source: https://github.com/highlightjs/highlight.js

## highlight.js GitHub themes — `github.min.css`, `github-dark.min.css`

- 来源主题 / Theme: GitHub（浅色）与 GitHub Dark（深色），highlight.js bundled styles
- 为什么是两份 / Why both: 代码块底色跟随 prefers-color-scheme（app.css 的 `--code-surface`），
  前景色必须跟着切——github-dark 的配色是为 `#0d1117` 挑的，压在浅底上读不了
- 版权与许可同 highlight.js / Copyright and license: same as highlight.js above (BSD-3-Clause)
- 来源 / Source: https://github.com/highlightjs/highlight.js/tree/main/src/styles

## MIT License（适用于 marked）

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## BSD-3-Clause（适用于 highlight.js 及其 GitHub 主题）

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
