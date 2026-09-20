import { createHash } from 'node:crypto';

// Public, static connection instructions. Never interpolate request data or credentials.
const endpoint = 'https://law.taxlab.kr/sse';
const cursorConfig = JSON.stringify({ mcpServers: { 'taxlab-law': {
  url: endpoint, headers: { Authorization: 'Bearer YOUR_API_KEY' },
} } }, null, 2);
const vscodeConfig = JSON.stringify({ servers: { 'taxlab-law': {
  type: 'sse', url: endpoint, headers: { Authorization: 'Bearer ${input:taxlab-api-key}' },
} }, inputs: [{ type: 'promptString', id: 'taxlab-api-key', description: 'TaxLab 접속키', password: true }] }, null, 2);
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, value => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[value]!));

const style = `
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;color:#162c3c;background:#f5f7fb;font-synthesis:none}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;line-height:1.75;word-break:keep-all}a{color:#164fb5;text-underline-offset:4px}button,a,summary{touch-action:manipulation}button{font:inherit;cursor:pointer}a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #f3b641;outline-offset:5px}
.wrap{max-width:1080px;margin:auto;padding:0 28px}.skip{position:absolute;left:16px;top:-80px;padding:10px 18px;background:white;z-index:2}.skip:focus{top:12px}
header{border-bottom:1px solid #dce3ee;background:#fff}nav{min-height:82px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{color:#142e45;text-decoration:none;font-size:23px;letter-spacing:-1px;font-weight:800}.brand span{font-size:14px;font-weight:500;letter-spacing:0;margin-left:12px;color:#506579;border-left:1px solid #cbd5e1;padding-left:14px}.nav-links{display:flex;gap:24px;font-size:14px}.nav-links a{color:#344c60;text-decoration:none}.nav-links a:hover{text-decoration:underline}
.intro{display:grid;grid-template-columns:1.05fr 1fr;align-items:center;gap:48px;padding:68px 0 56px}.eyebrow{color:#1957b9;font-size:14px;font-weight:750;letter-spacing:.06em;margin:0 0 18px}h1{font-size:clamp(32px,4.2vw,48px);line-height:1.3;letter-spacing:-.055em;margin:0 0 24px;font-weight:800}.lede{font-size:17px;color:#465d70;margin:0;max-width:440px}.lede strong{color:#172f45}.feature-line{margin:22px 0 0;color:#526679;font-size:14px}
.connection{background:#132f47;color:#fff;border-radius:18px;padding:30px;box-shadow:0 18px 45px #132f4712}.connection h2{margin:0;font-size:20px;letter-spacing:-.035em}.connection .hint{color:#c8d7e6;font-size:14px;margin:4px 0 20px}.endpoint{display:block;overflow-wrap:anywhere;background:#0b2338;border:1px solid #34516b;padding:16px;border-radius:8px;font-family:ui-monospace,Consolas,monospace;font-size:16px;user-select:all;line-height:1.7}.primary{border:0;border-radius:8px;background:#d4e5ff;color:#13345b;font-weight:750;width:100%;padding:12px 20px;margin-top:12px;min-height:48px}.primary:hover{background:#e9f2ff}.connection dl{margin:20px 0 0;display:grid;grid-template-columns:76px 1fr;gap:7px;font-size:14px}.connection dt{color:#b9ccdd}.connection dd{margin:0;overflow-wrap:anywhere}.connection code{font-size:13px}.connection a{color:#d4e5ff}
.steps{list-style:none;padding:0 0 38px;margin:0;display:grid;grid-template-columns:repeat(3,1fr);gap:28px;border-bottom:1px solid #d5deeb}.step-number{font:600 14px ui-monospace,Consolas,monospace;color:#1c58ba}.steps h2{font-size:17px;margin:7px 0 5px}.steps p{font-size:14px;color:#526679;margin:0}
section{padding:40px 0;scroll-margin-top:22px}.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:20px;margin-bottom:18px}.section-heading h2{margin:0;font-size:25px;letter-spacing:-.04em}.section-heading p{font-size:14px;color:#526679;margin:0}.note{border-left:3px solid #255fb8;padding:2px 0 2px 16px;color:#455b6e;font-size:15px;margin:0 0 22px}.note strong{color:#163d72}
details{background:#fff;border:1px solid #d8e1ee;border-radius:12px;margin:12px 0;overflow:hidden}summary{cursor:pointer;padding:20px 24px;font-size:17px;font-weight:700}summary::marker{color:#2d63b4}details[open] summary{border-bottom:1px solid #e5eaf2}.detail-body{padding:4px 24px 24px}.detail-body p{font-size:15px;color:#465d70}.detail-body code,.steps code,.note code{font-family:ui-monospace,Consolas,monospace;font-size:.9em;overflow-wrap:anywhere}.code-head{display:flex;justify-content:space-between;align-items:center;gap:12px;background:#edf2f8;padding:10px 16px;border-radius:8px 8px 0 0;color:#4a5f73;font-size:13px}.copy{border:1px solid #b9c9df;border-radius:6px;background:#fff;color:#23466c;padding:6px 12px;font-size:14px;min-height:36px}.copy:hover{background:#e6effc}pre{margin:0;padding:18px;background:#f5f7fb;border:1px solid #e0e7f1;border-top:0;border-radius:0 0 8px 8px;overflow:auto;max-width:100%;font-size:14px;line-height:1.7;word-break:normal}pre code{font-size:inherit!important;user-select:all}.doc-link{font-size:14px;display:inline-block;margin-top:12px}
.try{background:#eaf0fb;border-radius:12px;padding:24px;margin-top:24px}.try h3{font-size:16px;margin:0 0 8px}.try p{margin:0;font-size:15px;color:#294b73}.try .small{margin-top:9px;color:#4d657e;font-size:14px}
.help{border-top:1px solid #d5deeb}.help h2{font-size:25px;margin:0 0 20px;letter-spacing:-.04em}.help details{background:transparent}.help summary{font-size:16px}.help .detail-body p:last-child{margin-bottom:0}footer{border-top:1px solid #dce3ee;padding:26px 0 34px;color:#526679;font-size:14px}.footer-row{display:flex;justify-content:space-between;gap:24px}footer a{color:#526679}.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#172f45;color:#fff;border-radius:10px;padding:12px 22px;font-size:14px;box-shadow:0 8px 24px #10263d26;max-width:calc(100% - 32px);text-align:center;z-index:3}.toast:empty{display:none}[data-copy]{display:none}.js [data-copy]{display:inline-block}
@media(max-width:760px){.wrap{padding:0 20px}nav{min-height:72px}.nav-links{gap:16px}.brand span{display:none}.intro{grid-template-columns:1fr;gap:28px;padding:36px 0}h1{margin-bottom:18px}.lede{max-width:none}.connection{padding:24px}.steps{grid-template-columns:1fr;gap:20px;padding-bottom:30px}.steps li{display:grid;grid-template-columns:30px 1fr;column-gap:10px}.step-number{grid-row:1/3;padding-top:3px}.steps h2{margin:0 0 3px}.steps p{grid-column:2}section{padding:30px 0}.section-heading{display:block}.section-heading p{margin-top:6px}summary{padding:18px}.detail-body{padding:2px 18px 18px}pre{font-size:13px;padding:14px}.footer-row{display:block}.footer-row p{margin:0 0 10px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

const script = `
document.documentElement.classList.add('js');
let toastTimer;
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    const status = document.getElementById('copy-status');
    clearTimeout(toastTimer);
    try {
      await navigator.clipboard.writeText(source.textContent.trim());
      status.textContent = '복사했습니다.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = '복사가 차단되어 내용을 선택했습니다. 직접 복사해 주세요.';
    }
    toastTimer = setTimeout(() => { status.textContent = ''; }, 5000);
  });
}
`;
const hash = (text: string) => createHash('sha256').update(text).digest('base64');
export const landingHeaders = {
  'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${hash(style)}'; script-src 'sha256-${hash(script)}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
};

export const landingHtml = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TaxLab 법령 MCP · 연결 안내</title>
  <meta name="description" content="사용 중인 AI 앱에 한국 법령 조회와 초안 검증 도구를 연결하세요. 원격 MCP 연결 주소, 접속키 설정, Cursor와 VS Code 연결 방법을 안내합니다.">
  <link rel="canonical" href="https://law.taxlab.kr/">
  <style>${style}</style>
</head>
<body>
  <a class="skip" href="#main">본문으로 이동</a>
  <header><nav class="wrap" aria-label="주 메뉴">
    <a class="brand" href="/">TaxLab<span>법령 MCP</span></a>
    <div class="nav-links"><a href="#connect">연결 방법</a><a href="#help">도움말</a></div>
  </nav></header>
  <main id="main" class="wrap">
    <div class="intro">
      <div>
        <p class="eyebrow">TAXLAB LEGAL MCP</p>
        <h1>쓰던 AI에,<br>한국 법령을 연결하세요.</h1>
        <p class="lede">법령을 찾고 원문을 확인하는 도구를 AI 앱에 연결합니다. <strong>원격 연결을 지원하는 앱에서는 Node.js 설치가 필요 없습니다.</strong></p>
        <p class="feature-line">법령 조회 · 원문 확인 · 제출한 초안 검증</p>
      </div>
      <div class="connection" aria-labelledby="connection-title">
        <h2 id="connection-title">MCP 연결 주소</h2>
        <p class="hint">사용하는 AI 앱의 MCP 설정에 등록하세요.</p>
        <code class="endpoint" id="endpoint">${endpoint}</code>
        <button class="primary" type="button" data-copy="endpoint">연결 주소 복사</button>
        <dl><dt>연결 방식</dt><dd>원격 SSE</dd><dt>인증</dt><dd>접속키 필요 · <a href="#access-key">접속키 안내</a></dd></dl>
      </div>
    </div>
    <ol class="steps" aria-label="연결 순서">
      <li><span class="step-number">01</span><h2>접속키 받기</h2><p>서비스를 안내한 운영자에게 접속키를 받으세요.</p></li>
      <li><span class="step-number">02</span><h2>AI 앱에 연결하기</h2><p>아래에서 앱에 맞는 설정을 복사하고 접속키를 입력하세요.</p></li>
      <li><span class="step-number">03</span><h2>법령 질문하기</h2><p>연결된 도구를 활성화하고 평소처럼 AI에게 질문하세요.</p></li>
    </ol>
    <section id="connect" aria-labelledby="connect-title">
      <div class="section-heading"><h2 id="connect-title">사용하는 앱에 연결하기</h2><p>별도 서버 설치 없이 주소와 접속키로 연결합니다.</p></div>
      <p class="note">현재는 <strong>원격 SSE와 인증 헤더</strong>를 지원하는 앱에서 연결할 수 있습니다. 아래 설정은 각 앱의 공식 문서 기준입니다. OAuth 로그인만 지원하는 연결 화면은 아직 사용할 수 없습니다.</p>
      <details open>
        <summary>Cursor</summary>
        <div class="detail-body">
          <p>개인 설정 파일 <code>~/.cursor/mcp.json</code>의 <code>mcpServers</code>에 아래 항목을 추가하세요. <code>YOUR_API_KEY</code>를 전달받은 접속키로 바꿉니다. 기존 서버 설정이 있다면 함께 유지하세요.</p>
          <div class="code-head"><span>mcp.json</span><button class="copy" type="button" data-copy="cursor-config">Cursor 설정 복사</button></div>
          <pre><code id="cursor-config">${escapeHtml(cursorConfig)}</code></pre>
          <p>저장 후 MCP 설정에서 <code>taxlab-law</code>를 활성화하고, 채팅의 도구 목록을 확인하세요. 접속키가 들어간 개인 설정 파일은 공유하지 마세요.</p>
          <a class="doc-link" href="https://cursor.com/docs/context/mcp">Cursor 공식 연결 안내 ↗</a>
        </div>
      </details>
      <details>
        <summary>VS Code · GitHub Copilot</summary>
        <div class="detail-body">
          <p>명령 팔레트에서 <code>MCP: Open User Configuration</code>을 실행하세요. 아래의 <code>servers</code>와 <code>inputs</code> 항목을 기존 개인 설정에 추가하고, 서버를 시작할 때 나타나는 입력창에 접속키를 넣으세요.</p>
          <div class="code-head"><span>mcp.json · VS Code 로컬 채팅용</span><button class="copy" type="button" data-copy="vscode-config">VS Code 설정 복사</button></div>
          <pre><code id="vscode-config">${escapeHtml(vscodeConfig)}</code></pre>
          <p>서버 신뢰 확인 후 채팅의 도구 목록에서 <code>taxlab-law</code>를 활성화하세요. 입력창 방식은 VS Code 로컬 채팅용이며, Agent Host로 전달되는 설정에서는 별도 구성이 필요합니다.</p>
          <a class="doc-link" href="https://code.visualstudio.com/docs/agents/reference/mcp-configuration">VS Code 공식 설정 안내 ↗</a>
        </div>
      </details>
      <details>
        <summary>다른 원격 MCP 지원 앱</summary>
        <div class="detail-body">
          <p>연결 방식을 <strong>SSE</strong>, 주소를 <code>${endpoint}</code>로 설정하세요. 인증 헤더에는 <code>Authorization: Bearer YOUR_API_KEY</code>를 넣습니다. 또는 <code>x-api-key</code> 헤더에 접속키만 넣을 수 있습니다.</p>
          <p>접속키는 URL 뒤에 붙이지 마세요. 인증 헤더를 설정할 수 없거나 Streamable HTTP만 지원하는 앱은 현재 이 방식으로 바로 연결할 수 없습니다.</p>
        </div>
      </details>
      <div class="try"><h3>연결했다면 이렇게 질문해 보세요</h3><p>“TaxLab 도구로 근로기준법 제60조를 조회하고, 조문 원문과 시행일을 보여줘.”</p><p class="small">도구 목록에 <code>search_law</code>, <code>get_law_text</code> 등이 나타나면 연결된 상태입니다. 질문에 해당 사건의 기준일도 함께 알려주면 좋습니다.</p></div>
    </section>
    <section class="help" id="help" aria-labelledby="help-title">
      <h2 id="help-title">연결 전에 궁금한 점</h2>
      <details id="access-key"><summary>접속키는 어디서 받나요?</summary><div class="detail-body"><p>이 서비스를 안내한 운영자에게 요청하세요. 현재 이 페이지에서 접속키를 자동 발급하거나 입력받지는 않습니다. 전달받은 키는 사용하는 AI 앱의 인증 설정에 입력하면 됩니다.</p></div></details>
      <details><summary>이 사이트에서 바로 AI와 대화하나요?</summary><div class="detail-body"><p>이곳은 법령 도구의 연결 안내 페이지입니다. 질문과 답변은 사용 중인 AI 앱에서 진행합니다. AI 앱에 MCP 서버를 등록하면 질문에 필요한 법령 자료를 도구로 조회할 수 있습니다.</p></div></details>
      <details><summary>Node.js를 꼭 설치해야 하나요?</summary><div class="detail-body"><p>위와 같은 원격 연결에는 내 컴퓨터에 Node.js를 설치할 필요가 없습니다. 서버 운영은 TaxLab에서 담당합니다. 로컬 프로그램 실행 방식(stdio)만 지원하는 앱은 별도 연결기가 필요하고, 제공되는 Node.js 연결기를 선택한 경우에만 로컬 Node.js가 필요합니다.</p></div></details>
      <details><summary>ChatGPT나 Claude에 주소만 넣으면 되나요?</summary><div class="detail-body"><p>현재 서버는 접속키를 인증 헤더로 보내는 원격 SSE 연결을 제공합니다. 사용하는 앱의 연결 화면이 이 설정을 지원해야 합니다. 주소만 입력하거나 OAuth 로그인으로 연결하는 방식은 아직 제공하지 않습니다.</p></div></details>
      <details><summary>연결할 때 인증 오류가 나요.</summary><div class="detail-body"><p><code>401</code> 오류는 접속키와 인증 헤더를 확인하세요. Bearer 방식에서는 <code>Bearer</code> 뒤에 공백 한 칸과 접속키가 들어갑니다. 연결 주소를 브라우저에서 직접 여는 것만으로는 인증되지 않습니다. <code>429</code> 오류는 요청이 몰린 상태이므로 잠시 후 다시 시도하세요.</p></div></details>
    </section>
  </main>
  <footer><div class="wrap footer-row"><span>TaxLab 법령 MCP</span><span><a href="https://github.com/hyunae52/legal_harness">소스 코드</a> · <a href="/health">서버 상태</a></span></div></footer>
  <div class="toast" id="copy-status" role="status" aria-live="polite"></div>
  <script>${script}</script>
</body>
</html>`;
