import { createHash } from 'node:crypto';
import { agentPrompt, cursorConfig, geminiConfig, gptInstructions, mcpEndpoint, vscodeConfig } from './setup.js';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, value => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[value]!));
const codeBlock = (id: string, label: string, text: string) => `<div class="code-head"><span>${label}</span><button class="copy" data-copy="${id}">${label} 복사</button></div><pre><code id="${id}">${escapeHtml(text)}</code></pre>`;
const style = `
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;color:#183044;background:#f5f7fb;font-synthesis:none}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;line-height:1.75;word-break:keep-all}a{color:#205bb7;text-underline-offset:4px}button,a,summary{touch-action:manipulation}button{font:inherit;cursor:pointer}a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #dfab3f;outline-offset:5px}.wrap{max-width:1060px;margin:auto;padding:0 28px}.skip{position:absolute;left:16px;top:-80px;padding:10px 18px;background:white;z-index:2}.skip:focus{top:12px}
header{border-bottom:1px solid #dce3ee;background:#fff}nav{min-height:78px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{color:#142e45;text-decoration:none;font-size:23px;letter-spacing:-1px;font-weight:800}.brand span{font-size:14px;font-weight:500;letter-spacing:0;margin-left:12px;color:#506579;border-left:1px solid #cbd5e1;padding-left:14px}.nav-links{display:flex;gap:22px;font-size:14px}.nav-links a{color:#344c60;text-decoration:none}.nav-links a:hover{text-decoration:underline}
.intro{padding:62px 0 32px;max-width:760px}.eyebrow{color:#245bb0;font-size:13px;font-weight:750;letter-spacing:.1em;margin:0 0 16px}h1{font-size:clamp(32px,4.3vw,48px);line-height:1.3;letter-spacing:-.055em;margin:0 0 20px;font-weight:800}.lede{font-size:17px;color:#465d70;margin:0;max-width:620px}.key-note{font-size:14px;color:#53677b;margin:18px 0 0}.key-note strong{color:#183b68}
.apps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:0 0 28px}.app-card{background:#fff;border:1px solid #d7e1ed;border-radius:14px;padding:25px;display:flex;flex-direction:column;align-items:flex-start}.app-card.featured{border-top:4px solid #27599b;padding-top:22px}.app-card h2{font-size:23px;line-height:1.3;margin:10px 0 12px;letter-spacing:-.04em}.badge{color:#526c89;font-size:12px;font-weight:650;letter-spacing:.015em}.app-card p{font-size:14px;color:#506579;margin:0 0 20px;flex:1}.app-card .sub-link{margin-top:10px;font-size:13px}.button{display:inline-flex;align-items:center;justify-content:center;border:1px solid #c2d1e5;border-radius:8px;padding:10px 17px;background:#fff;color:#244e84;text-decoration:none;font-size:14px;font-weight:700;min-height:44px}.button:hover{background:#eef4ff}.button.primary{background:#204f88;color:white;border-color:#204f88}.button.primary:hover{background:#153c6d}
.agent{background:#172f46;color:#fff;border-radius:14px;padding:28px;display:grid;grid-template-columns:1fr auto;gap:14px 28px;align-items:center}.agent h2{font-size:20px;letter-spacing:-.035em;margin:0 0 8px}.agent p{margin:0;color:#c9d7e6;font-size:14px}.agent .button{background:#deebff;border-color:#deebff;color:#173c70;white-space:nowrap}.agent .prompt-details{grid-column:1/-1;margin:0;background:#10273b;border-color:#385069;color:#e5edf6}.agent summary{font-size:14px;padding:12px 16px}.agent .prompt{padding:14px 18px;margin:0;white-space:pre-wrap;font-size:14px;color:#dfebf9;overflow-wrap:anywhere}.agent a{color:#c3dbff}.agent details[open] summary{border-color:#385069}
section{padding:38px 0;scroll-margin-top:22px}.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:20px;margin-bottom:18px}.section-heading h2{margin:0;font-size:25px;letter-spacing:-.04em}.section-heading p{font-size:13px;color:#526679;margin:0}details{background:#fff;border:1px solid #d8e1ee;border-radius:12px;margin:12px 0;overflow:hidden}summary{cursor:pointer;padding:20px 23px;font-size:17px;font-weight:700}summary::marker{color:#2d63b4}summary .tag{font-size:12px;font-weight:500;color:#65798d;margin-left:9px}details[open]>summary{border-bottom:1px solid #e5eaf2}.detail-body{padding:4px 23px 23px}.detail-body p,.detail-body li{font-size:15px;color:#465d70}.detail-body li{margin:12px 0}.detail-body ol{padding-left:23px}.detail-body strong{color:#173b62}.detail-body code,.note code{font-family:ui-monospace,Consolas,monospace;font-size:.9em;overflow-wrap:anywhere}.notice{background:#f2f5fa;padding:16px 18px;border-radius:8px;font-size:14px!important}.doc-link{font-size:13px;margin-right:16px;display:inline-block;margin-top:5px}.code-head{display:flex;justify-content:space-between;align-items:center;gap:12px;background:#edf2f8;padding:10px 15px;border-radius:8px 8px 0 0;color:#4a5f73;font-size:13px}.copy{border:1px solid #b9c9df;border-radius:6px;background:#fff;color:#23466c;padding:6px 10px;font-size:13px;min-height:36px}.copy:hover{background:#e6effc}pre{margin:0 0 12px;padding:17px;background:#f5f7fb;border:1px solid #e0e7f1;border-top:0;border-radius:0 0 8px 8px;overflow:auto;max-width:100%;font-size:13px;line-height:1.7;word-break:normal}pre code{font-size:inherit!important;user-select:all}.instructions{white-space:pre-wrap}
.try{margin-top:20px;border-radius:10px;background:#eaf0fb;padding:20px}.try h3{font-size:16px;margin:0 0 6px}.try p{margin:0;font-size:15px;color:#284c75}.help{border-top:1px solid #d5deeb}.help h2{font-size:25px;margin:0 0 18px;letter-spacing:-.04em}.help summary{font-size:15px}.flow{font-size:15px!important;color:#244a79!important}footer{border-top:1px solid #dce3ee;padding:25px 0 32px;color:#526679;font-size:13px}.footer-row{display:flex;justify-content:space-between;gap:24px}footer a{color:#526679}.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#172f45;color:#fff;border-radius:10px;padding:12px 22px;font-size:14px;box-shadow:0 8px 24px #10263d26;max-width:calc(100% - 32px);text-align:center;z-index:3}.toast:empty{display:none}[data-copy]{display:none}.js [data-copy]{display:inline-flex}
@media(max-width:760px){.wrap{padding:0 20px}nav{min-height:70px}.nav-links{gap:15px}.brand span{display:none}.intro{padding:34px 0 26px}h1{margin-bottom:16px}.apps{grid-template-columns:1fr;gap:12px}.app-card{padding:20px}.app-card.featured{padding-top:17px}.app-card h2{margin:5px 0 7px;font-size:21px}.app-card p{margin-bottom:13px}.agent{padding:22px;grid-template-columns:1fr;gap:16px}.agent .button{justify-self:start}.agent .prompt-details{grid-column:1}.section-heading{display:block}.section-heading p{margin-top:6px}section{padding:29px 0}summary{padding:17px}summary .tag{display:block;margin:2px 0 0 17px}.detail-body{padding:3px 17px 18px}.detail-body ol{padding-left:21px}.footer-row{display:block}.footer-row p{margin:0 0 10px}.code-head{padding:10px;font-size:12px}.copy{font-size:12px}pre{padding:13px;font-size:12px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;
const script = `
document.documentElement.classList.add('js');
const openTarget = () => {
  const target = document.getElementById(location.hash.slice(1));
  if (target && target.tagName === 'DETAILS') target.open = true;
};
openTarget(); window.addEventListener('hashchange', openTarget);
for (const link of document.querySelectorAll('a[href^="#"]')) link.addEventListener('click', () => {
  const target = document.getElementById(link.getAttribute('href').slice(1));
  if (target && target.tagName === 'DETAILS') target.open = true;
});
let toastTimer;
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    const status = document.getElementById('copy-status'); clearTimeout(toastTimer);
    try { await navigator.clipboard.writeText(source.textContent.trim()); status.textContent = '복사했습니다.'; }
    catch {
      for (let parent = source.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      const range = document.createRange(); range.selectNodeContents(source);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      source.scrollIntoView({block:'center'}); status.textContent = '내용을 선택했습니다. 직접 복사해 주세요.';
    }
    toastTimer = setTimeout(() => { status.textContent = ''; }, 5000);
  });
}
`;
const hash = (text: string) => createHash('sha256').update(text).digest('base64');
export const landingHeaders = {
  'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${hash(style)}'; script-src 'sha256-${hash(script)}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache',
};
export const landingHtml = `<!doctype html>
<html lang="ko"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TaxLab 법령 · 내 AI에 연결하기</title>
  <meta name="description" content="Claude 설치파일, ChatGPT 설정 가져오기, Gemini CLI 연결 안내. AI에게 설정을 맡길 요청문도 준비했습니다.">
  <link rel="canonical" href="https://law.taxlab.kr/"><style>${style}</style>
</head><body>
  <a class="skip" href="#main">본문으로 이동</a>
  <header><nav class="wrap" aria-label="주 메뉴"><a class="brand" href="/">TaxLab<span>법령 MCP</span></a><div class="nav-links"><a href="#connect">연결 안내</a><a href="#help">도움말</a></div></nav></header>
  <main id="main" class="wrap">
    <div class="intro"><p class="eyebrow">TAXLAB LEGAL</p><h1>내 AI에<br>법령 검색을 더하세요.</h1><p class="lede">법령을 찾고, 원문을 읽고, 작성한 초안을 점검하세요.<br>쓰는 앱을 고르면 연결 방법을 안내해 드립니다.</p><p class="key-note">준비물은 <strong>운영자에게 받은 TaxLab 접속키 하나</strong>입니다.</p></div>
    <div class="apps" aria-label="사용하는 AI 고르기">
      <article class="app-card featured"><span class="badge">PC 앱 · Windows / macOS</span><h2>Claude</h2><p>설치파일을 열고 접속키를 넣으세요.<br>Claude PC 앱에서 사용할 수 있습니다.</p><a class="button primary" href="/downloads/taxlab-law.mcpb" download>Claude 설치파일 받기</a><a class="sub-link" href="#claude">설치 방법 보기 →</a></article>
      <article class="app-card"><span class="badge">GPT 만들기가 가능한 계정</span><h2>ChatGPT</h2><p>내 GPT에 법령 검색 기능을 넣으세요.<br>설정 주소를 가져오면 됩니다.</p><a class="button" href="#chatgpt">ChatGPT 설정하기 →</a></article>
      <article class="app-card"><span class="badge">PC 에이전트 · Gemini CLI</span><h2>Gemini</h2><p>CLI에서 법령 도구를 연결하세요.<br>일반 웹·앱은 현재 연결에 제한이 있습니다.</p><a class="button" href="#gemini">Gemini 연결 안내 →</a></article>
    </div>
    <div class="agent"><div><h2>설정은 AI에게 맡기고 싶다면</h2><p>아래 요청문을 PC 설정이 가능한 AI 에이전트에 붙여넣으세요.<br>일반 채팅에서는 수동 설정 안내를 받을 수 있습니다.</p></div><button class="button" data-copy="agent-prompt">AI 설정 요청문 복사</button><details class="prompt-details"><summary>요청문 보기</summary><p class="prompt" id="agent-prompt">${escapeHtml(agentPrompt)}</p><p class="prompt"><a href="/setup.md">AI용 연결 안내 문서 열기</a></p></details></div>
    <section id="connect" aria-labelledby="connect-title"><div class="section-heading"><h2 id="connect-title">앱별 연결 안내</h2><p>연결 방법 확인일 · 2026.09.20</p></div>
      <details id="claude" open><summary>Claude <span class="tag">PC 앱에서 설치파일로 연결</span></summary><div class="detail-body"><ol><li><a href="/downloads/taxlab-law.mcpb" download><strong>Claude 설치파일(.mcpb)</strong></a>을 내려받으세요.</li><li>Claude PC 앱의 <strong>설정 → 확장(Extensions) → 고급 설정 → Install Extension</strong>에서 파일을 선택하세요.</li><li><strong>TaxLab 접속키</strong> 입력창에 운영자에게 받은 키를 넣고 활성화하세요.</li><li>새 대화에서 TaxLab 도구를 켜고 아래 예시처럼 요청하세요.</li></ol><p class="notice">Claude 웹·모바일에는 이 PC 확장이 자동으로 연결되지 않습니다. 조직 계정은 관리자의 확장 설치 허용이 필요할 수 있습니다.</p><a class="doc-link" href="https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop">Claude 공식 설치 안내 ↗</a></div></details>
      <details id="chatgpt"><summary>ChatGPT <span class="tag">내 GPT에 설정 가져오기</span></summary><div class="detail-body"><ol><li>ChatGPT 웹에서 <strong>GPTs → 만들기 → 구성 → 새 작업(Action)</strong>을 여세요. GPT 만들기 기능이 있는 계정이 필요합니다.</li><li><strong>URL에서 가져오기</strong>에 아래 설정 주소를 넣으세요.</li></ol>${codeBlock('openapi-url', '설정 주소', 'https://law.taxlab.kr/openapi.json')}<ol start="3"><li><strong>인증 → API Key → Bearer</strong>를 선택하고 접속키만 입력하세요. 키 앞에 <code>Bearer</code>를 다시 붙이지 마세요.</li><li>아래 지침을 GPT의 <strong>지침(Instructions)</strong>에 붙여넣으세요.</li></ol><button class="button" data-copy="gpt-instructions">GPT 지침 복사</button><details><summary>GPT 지침 보기</summary><div class="detail-body"><p class="instructions" id="gpt-instructions">${escapeHtml(gptInstructions)}</p></div></details><ol start="5"><li><strong>listTaxlabTools</strong>를 테스트해 도구 목록이 나오면 <strong>나만 사용</strong>으로 저장하세요.</li></ol><p class="notice">이 방식은 <strong>GPT Actions</strong>로 같은 법령 서버에 연결합니다. 공유 접속키를 넣은 GPT는 공개 배포하지 마세요. ChatGPT의 MCP 앱 설정에 주소만 넣는 방식과는 다릅니다.</p><a class="doc-link" href="/downloads/chatgpt-actions.json" download>설정 파일 받기</a><a class="doc-link" href="https://developers.openai.com/api/docs/actions/getting-started">ChatGPT 공식 설정 안내 ↗</a><a class="doc-link" href="https://developers.openai.com/api/docs/actions/authentication">인증 안내 ↗</a></div></details>
      <details id="gemini"><summary>Gemini <span class="tag">CLI 연결 · 일반 앱의 제한 확인</span></summary><div class="detail-body"><p><strong>Gemini CLI를 쓰고 있다면</strong>, 위의 ‘AI 설정 요청문’을 붙여넣는 방법이 편합니다. 직접 설정할 때는 아래 파일의 <code>taxlab-law</code> 항목을 기존 <code>~/.gemini/settings.json</code>의 <code>mcpServers</code>에 추가하세요.</p><p>접속키는 로컬 환경변수 <code>TAXLAB_API_KEY</code>에 설정한 뒤 CLI를 다시 여세요. <strong>기존 설정 파일 전체를 덮어쓰지 마세요.</strong></p>${codeBlock('gemini-config', 'Gemini CLI 설정', geminiConfig)}<p><code>/mcp list</code>에서 TaxLab과 도구 목록이 보이면 연결된 것입니다.</p><a class="doc-link" href="/downloads/gemini-settings.json" download>설정 파일 받기</a><a class="doc-link" href="https://geminicli.com/docs/tools/mcp-server/">Gemini CLI 공식 안내 ↗</a><p class="notice"><strong>일반 Gemini 웹·모바일을 쓰고 있다면</strong><br>현재 Google의 사용자 지정 앱 안내는 미국·성인 개인 계정·영어 등 이용 조건이 있습니다. 국내 계정에서 주소만 넣는 연결은 아직 안내하기 어렵고, 이 서비스의 접속키 인증과 호환되는지도 확인이 필요합니다.</p><a class="doc-link" href="https://support.google.com/gemini/answer/17209137?co=GENIE.Platform%3DDesktop&amp;hl=en-GA">Google의 이용 조건 확인 ↗</a></div></details>
      <details id="advanced"><summary>다른 AI 에이전트에서 연결 <span class="tag">Claude Code · Cursor · VS Code 등</span></summary><div class="detail-body"><p>먼저 <strong>AI 설정 요청문</strong>을 사용하세요. 직접 설정하려면 아래 주소와 인증 헤더를 사용합니다.</p>${codeBlock('endpoint', 'MCP 주소', mcpEndpoint)}<p>방식: SSE · 인증: <code>Authorization: Bearer YOUR_API_KEY</code> 또는 <code>x-api-key: YOUR_API_KEY</code></p><p>현재 OAuth 로그인과 Streamable HTTP는 제공하지 않습니다. <strong>모든 앱에 주소만 넣어 연결되는 것은 아닙니다.</strong> Claude Code와 Codex 등은 <a href="/setup.md">AI용 안내 문서</a>에서 지원 범위를 확인하세요.</p><details><summary>Cursor 설정 예시</summary><div class="detail-body">${codeBlock('cursor-config', 'Cursor 설정', cursorConfig)}<p><code>YOUR_API_KEY</code>는 로컬에서 실제 키로 교체하고 설정 파일을 공개하지 마세요.</p></div></details><details><summary>VS Code 로컬 Copilot 설정 예시</summary><div class="detail-body">${codeBlock('vscode-config', 'VS Code 설정', vscodeConfig)}<p>기존 <code>servers</code>와 <code>inputs</code>에 병합하세요. 시작 시 접속키 입력창이 나타납니다.</p></div></details></div></details>
      <div class="try"><h3>연결 후 이렇게 요청해 보세요</h3><p>“TaxLab으로 근로기준법을 찾아 원문 링크와 시행일을 알려줘. 확인하지 못한 내용은 따로 표시해줘.”</p></div>
    </section>
    <section class="help" id="help" aria-labelledby="help-title"><h2 id="help-title">궁금한 점</h2>
      <details><summary>접속키는 어디서 받나요?</summary><div class="detail-body"><p>TaxLab 사용을 안내한 운영자에게 받으세요. 설치파일에는 키가 들어 있지 않습니다. 키를 채팅이나 웹 주소에 붙이지 말고, 안내된 앱 설정에 입력하세요.</p></div></details>
      <details><summary>연결했는데 응답이 없어요.</summary><div class="detail-body"><p>접속키가 정확한지, TaxLab 도구가 켜져 있는지 확인한 뒤 새 대화에서 다시 시도하세요. <a href="/health">서버 상태</a>가 <code>ok</code>여도 앱 인증까지 성공한 것은 아닙니다. 잠시 후 재시도해도 연결이 안 되면 키를 제외한 오류 메시지와 사용 앱을 운영자에게 알려주세요.</p></div></details>
      <details id="improvements"><summary>오류를 신고하면 PR로 수정되나요? <span class="tag">준비 중</span></summary><div class="detail-body"><p><strong>현재 자동 오류 접수·AI 수정안 검수·PR 생성은 운영에서 활성화되지 않았습니다.</strong> 도입할 흐름은 다음과 같습니다.</p><p class="flow">오류 신고 → AI 검토·수정안 작성 → PR 제출 → 사람이 최종 검수·머지</p><p>PR은 코드를 바꾸기 전에 검토할 수 있는 수정 제안입니다. 지금은 키를 제외한 오류 메시지를 운영자에게 전달해 주세요.</p></div></details>
      <details id="data"><summary>어떤 정보가 전송되나요?</summary><div class="detail-body"><p>AI 앱에서 도구 실행을 허용하면 질의·도구 인자·검사를 요청한 초안이 TaxLab 서버로 전송됩니다. 조회에 필요한 검색어·식별자는 원문 제공처로 전달될 수 있고, 결과는 사용하는 AI 앱으로 돌아갑니다. 앱 자체의 대화 저장 정책도 적용됩니다.</p><p>Claude 설치파일의 접속키는 앱의 비밀값 설정에서 관리합니다. 주민등록번호 등 법령 검색에 필요 없는 개인정보는 질의에 넣지 마세요.</p></div></details>
      <details><summary>검색 결과가 나오면 법률 검증까지 끝난 건가요?</summary><div class="detail-body"><p>조회 성공만으로 최신성이나 사건 적용이 확정되지는 않습니다. 사건 기준일·연혁·부칙·후속 해석을 확인해야 합니다. 초안 점검도 정해진 범위만 다루며, 확인되지 않은 내용은 미검증으로 표시합니다.</p></div></details>
    </section>
  </main>
  <footer><div class="wrap footer-row"><p>TaxLab · 법령 조회와 초안 점검</p><p><a href="/setup.md">AI용 연결 안내</a> · <a href="#data">데이터 전송 안내</a> · <a href="#improvements">오류 신고·PR</a></p></div></footer>
  <div class="toast" id="copy-status" role="status" aria-live="polite"></div><script>${script}</script>
</body></html>`;
