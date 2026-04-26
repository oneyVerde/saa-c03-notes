  const DOMAINS = {
    1: { name: 'Resilient Architectures', color: '#ff6b35' },
    2: { name: 'High-Performing',         color: '#00d4a8' },
    3: { name: 'Secure Architectures',    color: '#ffd23f' },
    4: { name: 'Cost-Optimized',          color: '#a78bfa' },
  };

  const REVIEW_KEY = 'saa_review_counts_v1';
  let reviewCounts = {};
  try { reviewCounts = JSON.parse(localStorage.getItem(REVIEW_KEY) || '{}'); } catch(e) {}

  const NOTES_KEY = 'saa_notes_v1';
  let notes = {};
  try { notes = JSON.parse(localStorage.getItem(NOTES_KEY) || '{}'); } catch(e) {}

  const BOOKMARKS_KEY = 'saa_bookmarks_v1';
  let bookmarks = {};
  try { bookmarks = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '{}'); } catch(e) {}

  // Questions are loaded from Supabase `questions` table.
  // 오프라인/비로그인 UX 개선을 위해 localStorage에 캐시합니다.
  const QUESTIONS_CACHE_KEY = 'saa_questions_v1';
  let questionsCache = [];
  try { questionsCache = JSON.parse(localStorage.getItem(QUESTIONS_CACHE_KEY) || '[]'); } catch(e) { questionsCache = []; }
  // `picked` 필드는 UI에서 참조하므로, cache에 없으면 기본값 세팅
  questionsCache.forEach(q => { if (q && typeof q.picked === 'undefined') q.picked = ''; });

  function escapeHtml(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ============================================================
  // Supabase cloud sync
  // ============================================================
  const sb = window.supabase.createClient(
    window.SUPABASE_CONFIG.url,
    window.SUPABASE_CONFIG.anonKey,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
  );

  let currentUser = null;
  let cloudOnline = false;

  function setCloudState(state, userEmail) {
    // state: 'off' | 'online' | 'syncing'
    const btn = document.getElementById('cloud-sync-btn');
    const text = document.getElementById('cloud-sync-text');
    if (!btn || !text) return;
    btn.classList.remove('online', 'syncing');
    if (state === 'online') {
      btn.classList.add('online');
      text.innerHTML = `<span class="label">Synced</span> <span class="email">${escapeHtml(userEmail || '')}</span>`;
    } else if (state === 'syncing') {
      btn.classList.add('syncing');
      text.innerHTML = `<span class="label">Syncing…</span>`;
    } else {
      text.innerHTML = `<span class="label">Cloud Sync</span> <span class="email">OFF</span>`;
    }
  }

  async function loadNotesFromCloud() {
    if (!currentUser) return;
    setCloudState('syncing');
    try {
      const { data, error } = await sb.from('notes').select('question_id, content, updated_at');
      if (error) throw error;

      // Cloud 값이 있는 질문은 cloud 버전으로 덮어씀
      const cloudMap = {};
      (data || []).forEach(r => { cloudMap[r.question_id] = r.content; notes[r.question_id] = r.content; });

      // 로컬에만 있는 메모를 cloud에 업로드 (첫 로그인 시 마이그레이션)
      const toUpload = [];
      for (const qid of Object.keys(notes)) {
        if (!(qid in cloudMap) && notes[qid] && notes[qid].trim() !== '') {
          toUpload.push({ user_id: currentUser.id, question_id: qid, content: notes[qid] });
        }
      }
      if (toUpload.length > 0) {
        const { error: upErr } = await sb.from('notes').upsert(toUpload);
        if (upErr) console.warn('migration upsert failed:', upErr);
      }

      localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
      setCloudState('online', currentUser.email);
    } catch (e) {
      console.error('loadNotesFromCloud:', e);
      setCloudState('off');
    }
  }

  async function loadQuestions() {
    if (!currentUser) return;
    try {
      const { data, error } = await sb
        .from('questions')
        .select('id, num, domain, topic, body, options, correct, explain')
        .order('num', { ascending: true });
      if (error) throw error;
      questionsCache = (data || []).map(q => ({ ...q, picked: '' }));
      localStorage.setItem(QUESTIONS_CACHE_KEY, JSON.stringify(questionsCache));
    } catch (e) {
      console.error('loadQuestions:', e);
    }
  }

  async function loadBookmarksFromCloud() {
    if (!currentUser) return;
    try {
      const { data, error } = await sb.from('bookmarks').select('question_id');
      if (error) throw error;
      const cloudSet = new Set((data || []).map(r => r.question_id));

      // 로컬에만 있는 북마크를 cloud로 업로드
      const localOnly = Object.keys(bookmarks).filter(qid => bookmarks[qid] && !cloudSet.has(qid));
      if (localOnly.length > 0) {
        const rows = localOnly.map(qid => ({ user_id: currentUser.id, question_id: qid }));
        const { error: upErr } = await sb.from('bookmarks').upsert(rows);
        if (upErr) console.warn('bookmarks migration failed:', upErr);
        localOnly.forEach(qid => cloudSet.add(qid));
      }

      // Cloud가 source of truth
      bookmarks = {};
      cloudSet.forEach(qid => { bookmarks[qid] = true; });
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
    } catch (e) {
      console.error('loadBookmarksFromCloud:', e);
    }
  }

  async function toggleBookmark(id, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    const wasMarked = !!bookmarks[id];
    if (wasMarked) delete bookmarks[id];
    else bookmarks[id] = true;
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));

    if (cloudOnline && currentUser) {
      try {
        if (wasMarked) {
          await sb.from('bookmarks').delete().match({ user_id: currentUser.id, question_id: id });
        } else {
          await sb.from('bookmarks').upsert({ user_id: currentUser.id, question_id: id });
        }
      } catch (e) { console.error('bookmark sync:', e); }
    }
    render();
    // 모달이 열려있으면 북마크 pill도 갱신
    if (modalState && modalState.q && modalState.q.id === id) renderModal();
  }

  async function initAuth() {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session && session.user) {
        currentUser = session.user;
        cloudOnline = true;
        await Promise.all([
          loadQuestions(),
          loadNotesFromCloud(),
          loadBookmarksFromCloud(),
        ]);
        render();
      } else {
        setCloudState('off');
      }
    } catch (e) {
      console.error('initAuth:', e);
      setCloudState('off');
    }

    sb.auth.onAuthStateChange(async (event, sess) => {
      if (event === 'SIGNED_IN' && sess && sess.user) {
        currentUser = sess.user;
        cloudOnline = true;
        await Promise.all([
          loadQuestions(),
          loadNotesFromCloud(),
          loadBookmarksFromCloud(),
        ]);
        render();
        closeAuthModal();
      } else if (event === 'SIGNED_OUT') {
        currentUser = null;
        cloudOnline = false;
        // 로그아웃 시 문제 캐시도 비워서 질문 내용이 남지 않게
        questionsCache = [];
        localStorage.removeItem(QUESTIONS_CACHE_KEY);
        setCloudState('off');
        render();
      }
    });
  }

  // ---- Save note (cloud + local) ----
  let saveNoteTimer = null;
  function saveNote(id, value) {
    notes[id] = value;
    const status = document.getElementById('memo-status');
    if (status) { status.textContent = '저장 중...'; status.classList.remove('saved'); }
    if (saveNoteTimer) clearTimeout(saveNoteTimer);
    saveNoteTimer = setTimeout(async () => {
      // 항상 로컬 저장 (오프라인 캐시)
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes));

      if (cloudOnline && currentUser) {
        try {
          const { error } = await sb.from('notes').upsert({
            user_id: currentUser.id,
            question_id: id,
            content: value,
            updated_at: new Date().toISOString(),
          });
          if (error) throw error;
          if (status) {
            status.textContent = '✓ 클라우드 저장됨';
            status.classList.add('saved');
            setTimeout(() => { if (status && status.textContent.startsWith('✓')) status.textContent = ''; }, 1800);
          }
        } catch (e) {
          console.error('cloud save:', e);
          if (status) { status.textContent = '⚠ 클라우드 실패 — 로컬 저장됨'; }
        }
      } else {
        if (status) {
          status.textContent = '✓ 로컬 저장됨 (로그인 시 동기화)';
          status.classList.add('saved');
          setTimeout(() => { if (status && status.textContent.startsWith('✓')) status.textContent = ''; }, 1800);
        }
      }
    }, 400);
  }

  // ---- Auth modal ----
  function openAuthModal() {
    renderAuthModal();
    document.getElementById('modal-auth').classList.add('open');
  }
  function closeAuthModal() {
    document.getElementById('modal-auth').classList.remove('open');
  }
  function renderAuthModal(msg, msgType) {
    const el = document.getElementById('modal-auth-content');
    if (currentUser) {
      const since = currentUser.last_sign_in_at ? new Date(currentUser.last_sign_in_at).toLocaleString('ko-KR') : '';
      el.innerHTML = `
        <button class="close" onclick="closeAuthModal()">×</button>
        <h3>Cloud Sync</h3>
        <p class="sub">메모가 Supabase에 자동 저장되고 모든 기기에서 동기화됩니다.</p>
        <div class="logged-in">
          <div class="who">${escapeHtml(currentUser.email)}</div>
          <div class="since">마지막 로그인: ${escapeHtml(since)}</div>
        </div>
        <button class="signout-btn" onclick="signOut()">로그아웃</button>
      `;
    } else {
      el.innerHTML = `
        <button class="close" onclick="closeAuthModal()">×</button>
        <h3>Cloud Sync 로그인</h3>
        <p class="sub">이메일로 매직 링크를 받습니다. 비밀번호 없이 클릭 한 번으로 로그인.</p>
        <form onsubmit="handleMagicLink(event)">
          <input type="email" id="auth-email" placeholder="your@email.com" required autocomplete="email" />
          <button type="submit" class="auth-submit" id="auth-submit-btn">매직 링크 받기</button>
        </form>
        ${msg ? `<div class="auth-msg ${msgType || ''}">${msg}</div>` : ''}
      `;
    }
  }

  async function handleMagicLink(e) {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    if (!email) return;
    const btn = document.getElementById('auth-submit-btn');
    btn.disabled = true;
    btn.textContent = '전송 중...';
    try {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname }
      });
      if (error) throw error;
      renderAuthModal(`✓ <strong>${escapeHtml(email)}</strong>로 매직 링크를 보냈습니다. 이메일의 링크를 클릭하면 자동 로그인됩니다.`, 'ok');
    } catch (e) {
      console.error('magic link:', e);
      renderAuthModal(`전송 실패: ${escapeHtml(e.message || e.toString())}`, 'error');
    }
  }

  async function signOut() {
    await sb.auth.signOut();
    closeAuthModal();
  }

  document.getElementById('modal-auth').addEventListener('click', (e) => {
    if (e.target.id === 'modal-auth') closeAuthModal();
  });

  initAuth();

  let chart = null;
  // currentFilter: 'all' | 'bookmarked' | '1' | '2' | '3' | '4' | 'service:Lambda' (etc.)
  let currentFilter = 'all';
  // searchQuery: 자유 텍스트 검색. 다른 필터와 AND로 결합됨.
  // 토큰 파싱:  "143" → num 정확 일치, "143-160" → 범위, "143,150" → OR 리스트,
  //           그 외 → topic/body/options/explain/서비스/도메인 라벨 substring 매칭.
  let searchQuery = '';

  // Pagination state for §01 question list
  let currentPage = 1;
  let pageSize = 10;
  try {
    const savedSize = parseInt(localStorage.getItem('saa_page_size_v1') || '', 10);
    if ([5,10,20,50].includes(savedSize)) pageSize = savedSize;
  } catch (e) {}

  function getQuestions() {
    return (questionsCache || []).slice().sort((a,b) => (a.num||0) - (b.num||0));
  }

  function setFilter(f, opts) {
    // opts.silent = true 이면 chip 활성 클래스 갱신 안 함 (서비스 필터 등 외부 트리거에서 사용)
    if (currentFilter !== f) currentPage = 1;
    currentFilter = f;
    // §01 filterbar의 chip 활성 상태를 동기화
    document.querySelectorAll('#filterbar .chip').forEach(c => {
      c.classList.toggle('active', c.dataset.filter === f);
    });
    render();
  }

  function clearServiceFilter() {
    setFilter('all');
  }

  function render() {
    const qs = getQuestions();
    document.getElementById('stat-total').textContent = qs.length;
    document.getElementById('stat-domains').textContent = new Set(qs.map(q => q.domain)).size;
    renderInsight(qs);
    renderList(qs);
    renderChart(qs);
    renderRangeChart();
    renderMatrix(qs);
  }

  // AWS 서비스 키워드 (topic 파싱용) — 긴 이름이 먼저 와야 부분 매칭 오염 방지
  const SERVICE_KEYWORDS = [
    // 복합어 / 긴 이름 먼저
    'IAM Identity Center', 'Fast Snapshot Restore', 'Intelligent-Tiering',
    'Reserved Instance', 'On-Demand', 'Spot Instance',
    'Network Firewall', 'Firewall Manager', 'Global Accelerator', 'Auto Scaling',
    'Route 53', 'Route53', 'API Gateway', 'Step Functions', 'Storage Gateway',
    'Gateway Endpoint', 'VPC Endpoint', 'NAT Gateway', 'Internet Gateway',
    'Direct Connect', 'Transit Gateway', 'Secrets Manager', 'Systems Manager',
    'Session Manager', 'Run Command', 'Object Lock', 'Job Bookmark',
    'CloudFront', 'CloudWatch', 'CloudTrail', 'CloudFormation',
    'EventBridge', 'Organizations', 'PrivateLink', 'Bastion',
    'DynamoDB', 'ElastiCache', 'GuardDuty', 'Inspector', 'Macie',
    'Rekognition', 'QuickSight', 'Transfer Family',
    'Kinesis', 'Redshift', 'Athena', 'Glue', 'DataSync', 'Snowball', 'Backup',
    'Fargate', 'Lambda', 'Aurora', 'Cognito', 'Config', 'Shield', 'WAF',
    'KMS', 'ACM', 'IAM', 'SSO',
    'RDS', 'S3', 'SQS', 'SNS', 'SES', 'EC2', 'EBS', 'EFS', 'FSx', 'VPN',
    'ALB', 'NLB', 'ELB', 'VPC', 'ECS', 'EKS'
  ];

  function extractServices(topic) {
    const found = new Set();
    let lower = (topic || '').toLowerCase();
    // 긴 키워드가 먼저 매칭되도록 SERVICE_KEYWORDS가 정렬돼 있음.
    // 매칭된 구간은 공백으로 치환해서 짧은 키워드가 같은 위치에서 중복 매칭되는 것을 방지
    // (예: "VPC Endpoint" 매치 후 "VPC"가 다시 매치되면 안 됨)
    for (const s of SERVICE_KEYWORDS) {
      const needle = s.toLowerCase();
      if (lower.includes(needle)) {
        found.add(s);
        lower = lower.split(needle).join(' ');
      }
    }
    return [...found];
  }

  // ============================================================
  // 검색 — 번호 / 범위 / 키워드 / 서비스 / 도메인 한글 라벨까지 모두 한 박스에서.
  // ============================================================
  // Haystack: 한 문제의 검색 가능한 모든 텍스트를 한 줄로. 도메인 한글 라벨도
  // 포함시켜 "보안", "복원력" 같은 검색이 가능하게 함.
  const DOMAIN_KR = { 1: '복원력', 2: '고성능 성능', 3: '보안', 4: '비용 cost-optimized' };
  function buildHaystack(q) {
    const optionsText = (q.options || []).map(o => `${o.k} ${o.v}`).join(' ');
    const services = extractServices(q.topic).join(' ');
    const domainName = (DOMAINS[q.domain] || {}).name || '';
    const domainKr = DOMAIN_KR[q.domain] || '';
    return [
      q.id, `q${q.num}`, String(q.num),
      q.topic, q.body, optionsText, q.explain || '',
      services, domainName, domainKr
    ].join(' ').toLowerCase();
  }

  // 토큰 단위 매칭. 모든 토큰이 매치돼야(AND) 통과.
  function matchesSearch(q, query) {
    const raw = (query || '').trim();
    if (!raw) return true;
    const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = buildHaystack(q);
    for (const t of tokens) {
      // 범위:  "143-160"  ("q143-q160" 도 허용)
      const rangeM = /^q?(\d+)-q?(\d+)$/.exec(t);
      if (rangeM) {
        const lo = parseInt(rangeM[1], 10), hi = parseInt(rangeM[2], 10);
        if (!(q.num >= Math.min(lo, hi) && q.num <= Math.max(lo, hi))) return false;
        continue;
      }
      // 콤마 리스트: "143,150,151"
      if (/^q?\d+(,q?\d+)+$/.test(t)) {
        const nums = t.split(',').map(x => parseInt(x.replace(/^q/, ''), 10));
        if (!nums.includes(q.num)) return false;
        continue;
      }
      // 단일 번호: "143" / "q143"
      const numM = /^q?(\d+)$/.exec(t);
      if (numM) {
        if (q.num !== parseInt(numM[1], 10)) return false;
        continue;
      }
      // 그 외: 자유 텍스트 substring (대소문자 무시)
      if (!hay.includes(t)) return false;
    }
    return true;
  }

  function applySearch(items) {
    if (!searchQuery) return items;
    return items.filter(q => matchesSearch(q, searchQuery));
  }

  // 검색창 옆 매치 카운터 갱신. 검색 비활성화 시 hidden.
  function updateSearchCount(n) {
    const el = document.getElementById('qsearch-count');
    if (!el) return;
    if (!searchQuery) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = `${n} 매치`;
  }

  // ============================================================
  // Weakness Matrix — 서비스 계층 × 도메인 2D 약점 분류
  // ============================================================
  // 각 셀은 "이 계층 × 이 도메인"에서 몇 번 틀렸는지 표시 (heatmap).
  // 한 문제가 여러 계층 키워드를 포함하면 각 계층에 모두 카운트됨 (coverage 관점).
  const SERVICE_LAYERS = {
    storage:  { label: 'Storage',  icon: '◈', hint: 'S3 · EBS · EFS · Glacier · Storage Gateway',
                keywords: ['S3','Glacier','Intelligent-Tiering','Object Lock','EBS','EFS','FSx','Storage Gateway','Snowball','Backup','Instance Store','DataSync'] },
    compute:  { label: 'Compute',  icon: '▶', hint: 'EC2 · Lambda · Fargate · ECS / EKS · Auto Scaling',
                keywords: ['EC2','Lambda','Fargate','ECS','EKS','Auto Scaling','Spot Instance','Reserved Instance','On-Demand','Savings Plan','Beanstalk','Bastion'] },
    database: { label: 'Database', icon: '▤', hint: 'RDS · Aurora · DynamoDB · ElastiCache · DAX',
                keywords: ['RDS','Aurora','DynamoDB','ElastiCache','DAX','Redshift','DocumentDB','Neptune','DMS'] },
  };

  // 도메인 열 순서 (사용자 매트릭스 기준: 보안 → 복원력 → 성능 → 비용)
  const MATRIX_DOMAIN_COLS = [
    { id: 3, label: '보안',   varName: '--accent-3' },
    { id: 1, label: '복원력', varName: '--accent'   },
    { id: 2, label: '고성능', varName: '--accent-2' },
    { id: 4, label: '비용',   varName: '--domain-4' },
  ];

  // 사용자가 제공한 약점 매트릭 — 각 셀에서 출제되는 대표 주제 힌트
  const MATRIX_CELL_HINTS = {
    'storage|3':  '버킷 정책, KMS 암호화 통제',
    'storage|1':  '교차 리전 복제(CRR), 버전 관리',
    'storage|2':  'Transfer Acceleration, 멀티파트',
    'storage|4':  '수명 주기, Glacier 전환',
    'compute|3':  'IAM Role (PassRole), 인스턴스 프로파일',
    'compute|1':  'ASG 수명 주기, 다중 AZ 배포',
    'compute|2':  '컴퓨팅 최적화, Lambda 동시성',
    'compute|4':  'Spot, Savings Plans',
    'database|3': 'Secrets Manager, 전송 중 암호화',
    'database|1': 'Multi-AZ Failover, 백업 전략',
    'database|2': 'Read Replica, ElastiCache / DAX',
    'database|4': 'Aurora Serverless, 인스턴스 중지',
  };

  function detectLayers(topic) {
    const layers = new Set();
    const lower = (topic || '').toLowerCase();
    for (const [key, def] of Object.entries(SERVICE_LAYERS)) {
      for (const kw of def.keywords) {
        if (lower.includes(kw.toLowerCase())) { layers.add(key); break; }
      }
    }
    return layers;
  }

  function matchesMatrix(q, layer, domainId) {
    if (String(q.domain) !== String(domainId)) return false;
    const layers = detectLayers(q.topic);
    return layers.has(layer);
  }

  function setMatrixFilter(layer, domainId) {
    setFilter(`matrix:${layer}|${domainId}`, { silent: true });
  }

  function renderInsight(qs) {
    const box = document.getElementById('insight-box');
    const n = qs.length;
    if (n === 0) { box.innerHTML = ''; return; }

    // 도메인 집계
    const counts = {1:0,2:0,3:0,4:0};
    qs.forEach(q => counts[q.domain]++);
    let maxD = 1, maxV = 0;
    for (const d in counts) if (counts[d] > maxV) { maxV = counts[d]; maxD = d; }
    const pct = Math.round((maxV / n) * 100);

    // 서비스 집계
    const serviceCounts = {};
    qs.forEach(q => {
      extractServices(q.topic).forEach(s => {
        serviceCounts[s] = (serviceCounts[s] || 0) + 1;
      });
    });
    const serviceEntries = Object.entries(serviceCounts).sort((a,b) => b[1]-a[1]);
    const repeatServices = serviceEntries.filter(([, c]) => c >= 2);

    // 주제 반복 (동일 topic 문자열)
    const topicCounts = {};
    qs.forEach(q => { const t = q.topic || '미분류'; topicCounts[t] = (topicCounts[t]||0)+1; });
    const repeatTopics = Object.entries(topicCounts).filter(([, c]) => c >= 2).sort((a,b) => b[1]-a[1]);

    let html = '';
    if (n < 3) {
      html = `<div class="insight"><div class="label">◆ Pattern Detected</div><div class="msg">데이터가 아직 적습니다 (n=${n}). 3개 이상 누적되면 패턴이 드러납니다.</div></div>`;
    } else {
      let msg = `전체 오답의 <strong style="color:var(--accent)">${pct}%</strong>가 <strong>${DOMAINS[maxD].name}</strong>에 해당합니다.`;
      if (repeatTopics.length > 0) {
        msg += ` 특히 <strong style="color:var(--accent-3)">${escapeHtml(repeatTopics[0][0])}</strong> 주제가 <strong>${repeatTopics[0][1]}번</strong> 반복됐습니다.`;
      } else if (repeatServices.length > 0) {
        const top = repeatServices.slice(0, 2).map(([s,c]) => `<strong style="color:var(--accent-3)">${escapeHtml(s)}</strong>(${c}회)`).join(', ');
        msg += ` ${top} 관련 문제가 반복 출제되고 있습니다.`;
      }

      html = `<div class="insight"><div class="label">◆ Pattern Detected</div><div class="msg">${msg}</div>`;

      // 서비스 breakdown (top 20, 2회 이상은 hot 강조). 클릭 시 §01 리스트 필터링.
      const topServices = serviceEntries.slice(0, 20);
      if (topServices.length > 0) {
        html += `<div class="service-breakdown">
          <div class="sb-label">◆ Service Frequency</div>
          <div class="sb-row">${topServices.map(([s,c]) => {
            const active = currentFilter === ('service:' + s);
            const cls = `sb-chip ${c >= 2 ? 'hot' : ''} ${active ? 'active' : ''}`;
            return `<button type="button" class="${cls}" onclick="setFilter('service:${escapeHtml(s)}')" title="${escapeHtml(s)} 관련 문제만 보기">
              <span class="sb-name">${escapeHtml(s)}</span><span class="sb-count">${c}</span>
            </button>`;
          }).join('')}</div>
        </div>`;
      }
      html += `</div>`;
    }
    box.innerHTML = html;
  }

  function renderList(qs) {
    const wrap = document.getElementById('qlist');
    const bannerSlot = document.getElementById('filter-banner-slot');
    const pagerSlot = document.getElementById('pager-slot');

    let items = qs;
    let serviceName = null;
    let matrixTag = null;
    if (currentFilter === 'bookmarked') {
      items = items.filter(q => bookmarks[q.id]);
    } else if (currentFilter && currentFilter.startsWith('service:')) {
      serviceName = currentFilter.slice('service:'.length);
      const needle = serviceName.toLowerCase();
      items = items.filter(q => (q.topic || '').toLowerCase().includes(needle));
    } else if (currentFilter && currentFilter.startsWith('matrix:')) {
      const [layer, domId] = currentFilter.slice('matrix:'.length).split('|');
      items = items.filter(q => matchesMatrix(q, layer, domId));
      const layerLabel = (SERVICE_LAYERS[layer] || {}).label || layer;
      const domLabel = (MATRIX_DOMAIN_COLS.find(d => String(d.id) === String(domId)) || {}).label || domId;
      matrixTag = `${layerLabel} × ${domLabel}`;
    } else if (currentFilter !== 'all') {
      items = items.filter(q => String(q.domain) === currentFilter);
    }
    // 검색은 다른 필터들과 AND로 결합 (가장 마지막에 적용)
    items = applySearch(items);
    // 검색창 옆 카운터 갱신
    updateSearchCount(items.length);

    // 서비스/매트릭스 필터 활성 시 §01 위에 배너 표시
    if (bannerSlot) {
      if (serviceName) {
        bannerSlot.innerHTML = `<div class="filter-banner">
             <span class="fb-label">필터링 중</span>
             <span class="fb-name">${escapeHtml(serviceName)}</span>
             <span style="color:var(--ink-faint); font-size:11px;">— ${items.length}개 매칭</span>
             <button class="fb-clear" onclick="clearServiceFilter()">× 클리어</button>
           </div>`;
      } else if (matrixTag) {
        bannerSlot.innerHTML = `<div class="filter-banner">
             <span class="fb-label">매트릭스 필터</span>
             <span class="fb-name">${escapeHtml(matrixTag)}</span>
             <span style="color:var(--ink-faint); font-size:11px;">— ${items.length}개 매칭</span>
             <button class="fb-clear" onclick="clearServiceFilter()">× 클리어</button>
           </div>`;
      } else {
        bannerSlot.innerHTML = '';
      }
    }

    if (items.length === 0) {
      let emptyMsg;
      if (searchQuery) {
        emptyMsg = `<div class="empty"><h3>"${escapeHtml(searchQuery)}" 검색 결과 없음</h3><p>번호(<code>143</code>) · 범위(<code>143-160</code>) · 키워드(<code>S3</code>, <code>Lambda</code>, <code>Multi-AZ</code>, <code>보안</code>)로 검색해보세요. 필터 칩과 동시에 적용됩니다.</p></div>`;
      } else if (serviceName) {
        emptyMsg = `<div class="empty"><h3>${escapeHtml(serviceName)} 관련 문제가 없습니다</h3><p>다른 서비스를 선택하거나 필터를 클리어하세요.</p></div>`;
      } else if (currentFilter === 'bookmarked') {
        emptyMsg = `<div class="empty"><h3>북마크한 문제가 없습니다</h3><p>문제 옆의 ★을 눌러 중요한 문제를 표시해두세요.</p></div>`;
      } else if (!currentUser) {
        emptyMsg = `<div class="empty"><h3>로그인하면 문제가 나타납니다</h3><p>문제 데이터는 Supabase DB에 저장되어 있습니다. 우측 상단 <strong>Cloud Sync</strong> 버튼으로 로그인하세요.</p></div>`;
      } else {
        emptyMsg = `<div class="empty"><h3>아직 비어 있습니다</h3><p>Claude에게 스크린샷을 보내서 문제를 추가하세요.</p></div>`;
      }
      wrap.innerHTML = emptyMsg;
      if (pagerSlot) pagerSlot.innerHTML = '';
      return;
    }

    // 페이징
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    const startIdx = (currentPage - 1) * pageSize;
    const pageItems = items.slice(startIdx, startIdx + pageSize);

    wrap.innerHTML = pageItems.map(q => {
      const marked = !!bookmarks[q.id];
      return `
      <div class="qitem ${marked ? 'bookmarked' : ''}" onclick="openDetail('${q.id}')">
        <div class="qnum">#${String(q.num).padStart(2,'0')}</div>
        <div class="qbody">
          <div class="qtitle">${q.topic || '(주제 미지정)'}</div>
          <div class="qmeta">
            <span class="tag">${DOMAINS[q.domain].name}</span>
            <span class="sep">│</span>
            <span>${(q.body || '').slice(0, 60)}${(q.body || '').length > 60 ? '…' : ''}</span>
          </div>
        </div>
        <div class="answers">
          <div>picked <span class="wrong">${q.picked || '—'}</span></div>
          <div>answer <span class="right">${q.correct}</span></div>
        </div>
        <button class="bookmark-btn ${marked ? 'active' : ''}" onclick="toggleBookmark('${q.id}', event)" title="${marked ? '북마크 해제' : '북마크'}">${marked ? '★' : '☆'}</button>
      </div>`;
    }).join('');

    if (pagerSlot) pagerSlot.innerHTML = renderPagerHTML(items.length, totalPages, startIdx, pageItems.length);
  }

  // ---- Pagination helpers ----
  function renderPagerHTML(totalItems, totalPages, startIdx, shownCount) {
    const fromN = startIdx + 1;
    const toN = startIdx + shownCount;

    // 페이지 번호 버튼: 처음, 끝, 현재 주변 ±2 만 노출. 그 사이는 ... 으로.
    const pages = [];
    const push = (p) => pages.push(p);
    const window = 2;
    const min = Math.max(1, currentPage - window);
    const max = Math.min(totalPages, currentPage + window);
    if (min > 1) push(1);
    if (min > 2) push('…');
    for (let p = min; p <= max; p++) push(p);
    if (max < totalPages - 1) push('…');
    if (max < totalPages) push(totalPages);

    const buttons = pages.map(p => {
      if (p === '…') return `<span class="pg-ellipsis">…</span>`;
      const active = p === currentPage ? 'active' : '';
      return `<button class="${active}" onclick="goToPage(${p})">${p}</button>`;
    }).join('');

    return `
      <div class="pager">
        <div class="pg-info"><strong>${fromN}</strong>–<strong>${toN}</strong> / <strong>${totalItems}</strong>개</div>
        <div class="pg-controls">
          <button onclick="goToPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''} title="이전">‹</button>
          ${buttons}
          <button onclick="goToPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''} title="다음">›</button>
        </div>
        <label class="pg-size">
          페이지당
          <select onchange="setPageSize(this.value)">
            <option value="5"  ${pageSize===5  ? 'selected' : ''}>5</option>
            <option value="10" ${pageSize===10 ? 'selected' : ''}>10</option>
            <option value="20" ${pageSize===20 ? 'selected' : ''}>20</option>
            <option value="50" ${pageSize===50 ? 'selected' : ''}>50</option>
          </select>
        </label>
      </div>`;
  }

  function goToPage(p) {
    const n = parseInt(p, 10);
    if (!Number.isFinite(n)) return;
    currentPage = n;
    renderList(getQuestions());
    // 리스트 상단으로 스크롤
    const top = document.getElementById('filterbar');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setPageSize(v) {
    const n = parseInt(v, 10);
    if (![5,10,20,50].includes(n)) return;
    pageSize = n;
    currentPage = 1;
    try { localStorage.setItem('saa_page_size_v1', String(n)); } catch (e) {}
    renderList(getQuestions());
  }

  function renderChart(qs) {
    const ctx = document.getElementById('domain-chart');
    const counts = {1:0,2:0,3:0,4:0};
    qs.forEach(q => counts[q.domain]++);
    const data = {
      labels: ['Resilient', 'Performance', 'Secure', 'Cost'],
      datasets: [{
        label: 'Wrong Answers',
        data: [counts[1], counts[2], counts[3], counts[4]],
        backgroundColor: 'rgba(255,107,53,0.15)',
        borderColor: '#ff6b35',
        borderWidth: 2,
        pointBackgroundColor: ['#ff6b35','#00d4a8','#ffd23f','#a78bfa'],
        pointBorderColor: '#0a0e1a',
        pointBorderWidth: 2,
        pointRadius: 6,
        pointHoverRadius: 9,
      }]
    };
    const maxVal = Math.max(3, ...Object.values(counts));
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: 'radar',
      data,
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          r: {
            min: 0, max: maxVal,
            ticks: { stepSize: Math.max(1, Math.ceil(maxVal/4)), color: '#4a5268', backdropColor: 'transparent', font: { family: 'JetBrains Mono', size: 10 } },
            grid: { color: 'rgba(255,255,255,0.08)' },
            angleLines: { color: 'rgba(255,255,255,0.12)' },
            pointLabels: { color: '#e8ecf5', font: { family: 'Fraunces', size: 13, weight: '600', style: 'italic' } }
          }
        }
      }
    });
    const total = qs.length || 1;
    document.getElementById('chart-legend').innerHTML = Object.keys(DOMAINS).map(d => {
      const c = counts[d];
      const pct = Math.round((c/total)*100);
      return `<div class="legend-row"><span class="swatch" style="background:${DOMAINS[d].color}"></span><span class="name">${DOMAINS[d].name}</span><span class="pct">${pct}%</span><span class="cnt">${c}개</span></div>`;
    }).join('');
  }

  // ============================================================
  // Range Accuracy Chart — 문제 번호 구간별 정답률/오답률 추세 (꺾은선)
  // ============================================================
  let rangeChart = null;

  function setRangePreset(spec) {
    const el = document.getElementById('range-input');
    if (!el) return;
    el.value = expandRangeSpec(spec); // 균등 형식이면 명시적 구간으로 펼쳐서 보여줌
    renderRangeChart();
  }

  // ----- 구간 입력 파싱 -----
  // 지원 포맷:
  //   "1-100/10"               → 균등 분할 (1-10, 11-20, ..., 91-100)
  //   "10"                     → 1부터 끝까지 10씩 (끝이 없으면 maxNum 사용)
  //   "1-10, 11-51, 52-102"    → 비균등 명시
  //   "1-10; 11-51"            → 세미콜론도 허용
  function parseRangeSpec(raw) {
    const s = String(raw || '').trim();
    if (!s) return [];

    // "from-to/bucket" 균등 형식
    const uniform = s.match(/^(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)$/);
    if (uniform) {
      const from = parseInt(uniform[1], 10);
      const to   = parseInt(uniform[2], 10);
      const bk   = parseInt(uniform[3], 10);
      return buildUniformBuckets(from, to, bk);
    }

    // 단일 숫자 = 1부터 maxNum까지 그 크기로
    if (/^\d+$/.test(s)) {
      const bk = parseInt(s, 10);
      const qs = getQuestions();
      const maxNum = qs.length ? Math.max(...qs.map(q => parseInt(q.num,10) || 0)) : 100;
      return buildUniformBuckets(1, Math.max(maxNum, bk), bk);
    }

    // 콤마/세미콜론 구분 구간 리스트
    const parts = s.split(/[,;]/).map(p => p.trim()).filter(Boolean);
    const buckets = [];
    for (const p of parts) {
      const m = p.match(/^(\d+)\s*[-~–—]\s*(\d+)$/);
      if (!m) continue;
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (a > b) { const t=a; a=b; b=t; }
      if (a < 1) a = 1;
      buckets.push([a, b]);
    }
    return buckets;
  }

  function buildUniformBuckets(from, to, bk) {
    if (!Number.isFinite(from) || from < 1) from = 1;
    if (!Number.isFinite(to)   || to   < from) to = from;
    if (!Number.isFinite(bk)   || bk   < 1) bk = Math.max(1, Math.ceil((to - from + 1) / 10));
    // 너무 잘게 쪼개지지 않도록 max 100구간
    const totalRange = to - from + 1;
    if (totalRange / bk > 100) bk = Math.ceil(totalRange / 100);
    const out = [];
    for (let s = from; s <= to; s += bk) out.push([s, Math.min(s + bk - 1, to)]);
    return out;
  }

  // 균등/단축 입력을 명시적 "1-10, 11-20, ..." 으로 펼쳐서 input에 보여주는 헬퍼
  function expandRangeSpec(spec) {
    const buckets = parseRangeSpec(spec);
    return buckets.map(([a,b]) => a === b ? `${a}` : `${a}-${b}`).join(', ');
  }

  function renderRangeChart() {
    const ctx = document.getElementById('range-chart');
    if (!ctx) return;

    const inputEl = document.getElementById('range-input');
    const raw = inputEl ? inputEl.value : '1-100/10';
    let buckets = parseRangeSpec(raw);

    if (buckets.length === 0) {
      // 파싱 실패 → 기본값으로 폴백
      buckets = buildUniformBuckets(1, 100, 10);
      if (inputEl) inputEl.value = '1-100/10';
    }

    // 입력을 명시적 구간으로 정규화해서 다시 보여주기 (재현·편집 쉽게)
    if (inputEl) inputEl.value = buckets.map(([a,b]) => a === b ? `${a}` : `${a}-${b}`).join(', ');

    // 범위 안에 들어오는 오답 문제 번호 집합
    const minStart = Math.min(...buckets.map(b => b[0]));
    const maxEnd   = Math.max(...buckets.map(b => b[1]));
    const wrongNums = new Set();
    getQuestions().forEach(q => {
      const n = parseInt(q.num, 10);
      if (Number.isFinite(n) && n >= minStart && n <= maxEnd) wrongNums.add(n);
    });

    // 구간별 집계: 정답률(%) / 오답률(%) + 카운트
    const labels = [];
    const rightPctArr = [];
    const wrongPctArr = [];
    const wrongCounts = [];
    const rightCounts = [];
    const sizes = [];

    for (const [start, end] of buckets) {
      const total = end - start + 1;
      let wrong = 0;
      for (let n = start; n <= end; n++) if (wrongNums.has(n)) wrong++;
      const right = total - wrong;
      const wPct = total > 0 ? Math.round((wrong / total) * 1000) / 10 : 0;
      const rPct = Math.round((100 - wPct) * 10) / 10;
      labels.push(start === end ? `${start}` : `${start}–${end}`);
      wrongCounts.push(wrong);
      rightCounts.push(right);
      wrongPctArr.push(wPct);
      rightPctArr.push(rPct);
      sizes.push(total);
    }

    // 전체 요약
    const totalRange = sizes.reduce((a,b) => a+b, 0);
    const totalWrong = wrongCounts.reduce((a,b) => a+b, 0);
    const totalRight = totalRange - totalWrong;
    const overallWrongPct = totalRange > 0 ? Math.round((totalWrong / totalRange) * 1000) / 10 : 0;
    const overallRightPct = Math.round((100 - overallWrongPct) * 10) / 10;

    // 추세 화살표: 첫 vs 마지막 구간 정답률 비교
    let trendIcon = '';
    if (rightPctArr.length >= 2) {
      const first = rightPctArr[0];
      const last  = rightPctArr[rightPctArr.length - 1];
      const diff = Math.round((last - first) * 10) / 10;
      if (diff > 0)      trendIcon = `<span style="color:var(--accent-2)">▲ +${diff}%p</span>`;
      else if (diff < 0) trendIcon = `<span style="color:var(--danger)">▼ ${diff}%p</span>`;
      else               trendIcon = `<span style="color:var(--ink-faint)">→ 0</span>`;
    }

    document.getElementById('range-summary').innerHTML = `
      <span><span class="smetric">Range</span> <span class="sval">${minStart}–${maxEnd}</span> <span class="smetric">(${totalRange}문제, ${labels.length}구간)</span></span>
      <span class="ssep">│</span>
      <span><span class="smetric">오답</span> <span class="sval wrong">${totalWrong}</span> <span class="smetric">(${overallWrongPct}%)</span></span>
      <span class="ssep">│</span>
      <span><span class="smetric">정답</span> <span class="sval right">${totalRight}</span> <span class="smetric">(${overallRightPct}%)</span></span>
      ${trendIcon ? `<span class="ssep">│</span><span><span class="smetric">정답률 추세</span> ${trendIcon}</span>` : ''}
    `;

    // Chart.js line chart — 정답률↑ / 오답률↓ 추세
    if (rangeChart) rangeChart.destroy();
    rangeChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: '정답률 %',
            data: rightPctArr,
            borderColor: 'rgba(0, 212, 168, 1)',
            backgroundColor: 'rgba(0, 212, 168, 0.12)',
            borderWidth: 2.5,
            pointBackgroundColor: 'rgba(0, 212, 168, 1)',
            pointBorderColor: '#0a0e1a',
            pointBorderWidth: 2,
            pointRadius: 5,
            pointHoverRadius: 8,
            tension: 0.3,
            fill: true,
          },
          {
            label: '오답률 %',
            data: wrongPctArr,
            borderColor: 'rgba(255, 62, 95, 1)',
            backgroundColor: 'rgba(255, 62, 95, 0.08)',
            borderWidth: 2.5,
            pointBackgroundColor: 'rgba(255, 62, 95, 1)',
            pointBorderColor: '#0a0e1a',
            pointBorderWidth: 2,
            pointRadius: 5,
            pointHoverRadius: 8,
            tension: 0.3,
            fill: false,
            borderDash: [4, 4],
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            align: 'end',
            labels: { color: '#e8ecf5', font: { family: 'JetBrains Mono', size: 11 }, boxWidth: 18, boxHeight: 3, padding: 14, usePointStyle: false }
          },
          tooltip: {
            backgroundColor: '#0a0e1a',
            borderColor: '#303a52',
            borderWidth: 1,
            titleFont: { family: 'Fraunces', size: 13, weight: '600' },
            bodyFont: { family: 'JetBrains Mono', size: 11 },
            padding: 12,
            callbacks: {
              afterBody: (items) => {
                if (!items.length) return '';
                const idx = items[0].dataIndex;
                return [
                  ` 오답: ${wrongCounts[idx]}개 / 총 ${sizes[idx]}개`,
                ];
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#8892a6', font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 45, minRotation: 0 },
            grid: { color: 'rgba(255,255,255,0.04)' }
          },
          y: {
            min: 0, max: 100,
            ticks: {
              color: '#8892a6',
              stepSize: 20,
              font: { family: 'JetBrains Mono', size: 10 },
              callback: (v) => v + '%'
            },
            grid: { color: 'rgba(255,255,255,0.05)' },
            title: { display: true, text: '비율 (%)', color: '#4a5268', font: { family: 'JetBrains Mono', size: 10 } }
          }
        }
      }
    });
  }

  // Enter 키로도 바로 계산되도록 입력에 핸들러 부착
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('range-input');
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); renderRangeChart(); } });
  });
  // DOMContentLoaded는 이미 지났을 가능성이 높으므로 즉시도 시도
  (() => {
    const el = document.getElementById('range-input');
    if (el && !el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); renderRangeChart(); } });
    }
  })();

  let modalState = null;

  // --- multi-answer helpers ---
  // ============================================================
  // Weakness Matrix renderer — §04
  // ============================================================
  function renderMatrix(qs) {
    const wrap = document.getElementById('matrix-wrap');
    if (!wrap) return;

    // 계층 × 도메인 카운트. 한 문제가 여러 계층에 걸치면 각 셀에 중복 카운트.
    const counts = {};
    const untagged = [];
    for (const q of (qs || [])) {
      const layers = detectLayers(q.topic);
      if (layers.size === 0) { untagged.push(q); continue; }
      for (const layer of layers) {
        const key = `${layer}|${q.domain}`;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    const maxCount = Math.max(0, ...Object.values(counts));

    const colHeaders = MATRIX_DOMAIN_COLS.map(c =>
      `<th class="mx-col-head" style="color: var(${c.varName})">${c.label}</th>`
    ).join('');

    const rowsHtml = Object.entries(SERVICE_LAYERS).map(([layerKey, def]) => {
      const cells = MATRIX_DOMAIN_COLS.map(c => {
        const key = `${layerKey}|${c.id}`;
        const n = counts[key] || 0;
        const heat = maxCount > 0 ? (n / maxCount) : 0;
        const hint = MATRIX_CELL_HINTS[key] || '';
        const active = currentFilter === `matrix:${layerKey}|${c.id}`;
        return `<td class="mx-cell ${n === 0 ? 'empty' : ''} ${active ? 'active' : ''}"
                    style="--heat: ${heat.toFixed(3)}"
                    ${n > 0 ? `onclick="setMatrixFilter('${layerKey}','${c.id}')"` : ''}
                    title="${escapeHtml(hint)}${n > 0 ? ` — ${n}문제` : ''}">
                  <div class="mx-count">${n}</div>
                  <div class="mx-hint">${escapeHtml(hint)}</div>
                </td>`;
      }).join('');
      return `<tr>
        <th class="mx-row-head">
          <span class="mx-row-icon">${def.icon}</span>
          <span class="mx-row-label">${def.label}</span>
          <span class="mx-row-sub">${escapeHtml(def.hint)}</span>
        </th>
        ${cells}
      </tr>`;
    }).join('');

    const footNote = untagged.length > 0
      ? `<div class="mx-foot">※ 계층 미분류 ${untagged.length}문제 (네트워킹 · 모니터링 · 거버넌스 등)</div>`
      : '';

    wrap.innerHTML = `
      <table class="matrix-table">
        <thead><tr><th></th>${colHeaders}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      ${footNote}
    `;
  }

  // correct 필드는 "C" 또는 "C,D" 형식. 항상 정렬된 letter 배열로 반환.
  function parseCorrect(q) {
    return String(q && q.correct || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .sort();
  }
  function isMulti(q) { return parseCorrect(q).length > 1; }

  // --- navigation helpers: 현재 필터 안에서 이전/다음 문제 찾기 ---
  function getFilteredOrder() {
    let items = getQuestions(); // 이미 num 오름차순
    if (currentFilter === 'bookmarked') {
      items = items.filter(q => bookmarks[q.id]);
    } else if (currentFilter && currentFilter.startsWith('service:')) {
      const needle = currentFilter.slice('service:'.length).toLowerCase();
      items = items.filter(q => (q.topic || '').toLowerCase().includes(needle));
    } else if (currentFilter && currentFilter.startsWith('matrix:')) {
      const [layer, domId] = currentFilter.slice('matrix:'.length).split('|');
      items = items.filter(q => matchesMatrix(q, layer, domId));
    } else if (currentFilter !== 'all' && currentFilter) {
      items = items.filter(q => String(q.domain) === currentFilter);
    }
    // 검색 필터도 동일하게 적용 (모달 내 이전/다음 네비게이션이 검색 결과 안에서만 이동)
    items = applySearch(items);
    return items;
  }
  function findSiblings(qid) {
    const items = getFilteredOrder();
    const idx = items.findIndex(q => q.id === qid);
    if (idx >= 0) {
      return {
        prev: idx > 0 ? items[idx - 1] : null,
        next: idx < items.length - 1 ? items[idx + 1] : null,
        position: idx + 1,
        total: items.length,
        inFilter: true,
      };
    }
    // 현재 질문이 필터 밖에 있으면 전체에서 찾기 (안전망)
    const all = getQuestions();
    const i = all.findIndex(q => q.id === qid);
    return {
      prev: i > 0 ? all[i - 1] : null,
      next: i >= 0 && i < all.length - 1 ? all[i + 1] : null,
      position: i + 1,
      total: all.length,
      inFilter: false,
    };
  }
  function navPrev() {
    if (!modalState) return;
    const s = findSiblings(modalState.q.id);
    if (s.prev) openDetail(s.prev.id);
  }
  function navNext() {
    if (!modalState) return;
    const s = findSiblings(modalState.q.id);
    if (s.next) openDetail(s.next.id);
  }
  function renderNavHTML(prev, next) {
    const prevTitle = prev ? escapeHtml(prev.topic || '') : '';
    const nextTitle = next ? escapeHtml(next.topic || '') : '';
    return `<button class="modal-side-nav prev" onclick="navPrev()" ${prev ? '' : 'disabled'} title="${prevTitle}" aria-label="이전 문제">‹</button>
      <button class="modal-side-nav next" onclick="navNext()" ${next ? '' : 'disabled'} title="${nextTitle}" aria-label="다음 문제">›</button>`;
  }

  function openDetail(id) {
    const q = getQuestions().find(x => x.id === id);
    if (!q) return;
    // 모달 열 때는 항상 quiz mode로 시작 (답/해설 숨김)
    // userPicks: 선택한 letter 배열 (단일답이면 길이 0 또는 1, 복수답이면 여러 개)
    modalState = { q, revealed: false, userPicks: [] };
    renderModal();
    const modal = document.getElementById('modal-detail');
    modal.classList.add('open');
    // 스크롤 최상단으로 초기화 (이전 질문의 스크롤 위치 잔존 방지)
    const inner = document.getElementById('modal-content');
    if (inner && inner.parentElement) inner.parentElement.scrollTop = 0;
  }

  function renderModal() {
    if (!modalState) return;
    const { q, revealed, userPicks } = modalState;
    const reviews = reviewCounts[q.id] || 0;
    const note = notes[q.id] || '';
    const correctList = parseCorrect(q);
    const correctSet = new Set(correctList);
    const multi = correctList.length > 1;
    const pickedSet = new Set(userPicks);
    const pickedLabel = userPicks.slice().sort().join(', ');
    const correctLabel = correctList.join(', ');

    // 전부 맞췄는지 (복수답일 때 쓰임)
    const allCorrect = revealed
      && userPicks.length === correctList.length
      && userPicks.every(l => correctSet.has(l));

    // 이전/다음 문제 계산 (현재 필터 기준). 뷰포트 중앙에 고정된 사이드 화살표.
    const sib = findSiblings(q.id);
    const sideNav = renderNavHTML(sib.prev, sib.next);

    document.getElementById('modal-content').innerHTML = `
      <button class="close" onclick="closeDetail()">×</button>
      ${sideNav}
      <h3>#${String(q.num).padStart(2,'0')} · ${q.topic}</h3>
      <div class="qmeta-big">
        <span class="pill hot">${DOMAINS[q.domain].name}</span>
        <span class="pill bookmark-pill ${bookmarks[q.id] ? 'active' : ''}" onclick="toggleBookmark('${q.id}', event)" title="${bookmarks[q.id] ? '북마크 해제' : '북마크 추가'}">${bookmarks[q.id] ? '★ Bookmarked' : '☆ Bookmark'}</span>
        ${revealed
          ? `${pickedLabel ? `<span class="pill ${allCorrect ? 'ok' : 'wrong'}">내 선택: ${pickedLabel}${allCorrect ? ' ✓' : ''}</span>` : ''}<span class="pill ok">정답: ${correctLabel}</span>`
          : `<span class="pill quiz">Quiz Mode · 답 숨김</span>${multi ? '<span class="pill multi">복수 정답 (' + correctList.length + '개 선택)</span>' : ''}`
        }
      </div>
      <div class="q-text">${q.body || '(본문 없음)'}</div>
      ${q.options && q.options.length ? `
        <h4>◆ Options</h4>
        <div class="options">${q.options.map(o => {
          let cls = '';
          if (revealed) {
            cls = 'revealed';
            if (correctSet.has(o.k)) cls += ' correct';
            else if (pickedSet.has(o.k)) cls += ' picked-wrong';
          } else if (pickedSet.has(o.k)) {
            cls = 'picked';
          }
          const handler = revealed ? '' : `onclick="pickOption('${o.k}')"`;
          // 복수답일 때는 체크박스 느낌의 표식
          const badge = (!revealed && multi)
            ? `<span class="multi-check">${pickedSet.has(o.k) ? '✓' : ''}</span>`
            : '';
          return `<div class="opt ${cls}" ${handler}>${badge}<span class="letter">${o.k}</span><span>${o.v}</span></div>`;
        }).join('')}</div>
      ` : ''}
      ${revealed
        ? `${q.explain ? `<h4>◆ Why</h4><div class="explain">${q.explain}</div>` : ''}
           <button class="retry-btn" onclick="resetQuiz()">↻ 다시 풀기 (답 다시 숨기기)</button>`
        : `<button class="reveal-btn subtle" onclick="revealAnswer()">정답 보기</button>`
      }
      <div class="memo-section">
        <div class="memo-header">
          <span class="label">◆ My Notes</span>
          <span class="memo-status" id="memo-status"></span>
        </div>
        <textarea class="memo-box" placeholder="여기에 나만의 메모를 간략히 적어두세요..." oninput="saveNote('${q.id}', this.value)">${escapeHtml(note)}</textarea>
      </div>
      <div class="review-tracker">
        <span class="label">Reviewed</span>
        <span class="count" id="review-count">${reviews}</span>
        <span class="label">times</span>
        <button class="review-btn" onclick="addReview('${q.id}')">+ Mark Reviewed</button>
      </div>`;
  }

  function pickOption(letter) {
    if (!modalState || modalState.revealed) return;
    const { q } = modalState;
    const picks = modalState.userPicks;
    const idx = picks.indexOf(letter);

    if (isMulti(q)) {
      // 복수답: 토글. 공개는 사용자가 직접 버튼으로.
      if (idx >= 0) picks.splice(idx, 1);
      else picks.push(letter);
      picks.sort();
      renderModal();
    } else {
      // 단일답: 클릭 즉시 공개.
      modalState.userPicks = [letter];
      modalState.revealed = true;
      renderModal();
      scrollModalToAnswer();
    }
  }

  function revealAnswer() {
    if (!modalState) return;
    modalState.revealed = true;
    renderModal();
    scrollModalToAnswer();
  }

  function scrollModalToAnswer() {
    // 공개 직후 해설 섹션이 보이도록 스크롤
    requestAnimationFrame(() => {
      const explainEl = document.querySelector('#modal-content .explain');
      if (explainEl && typeof explainEl.scrollIntoView === 'function') {
        explainEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  function resetQuiz() {
    if (!modalState) return;
    modalState.revealed = false;
    modalState.userPicks = [];
    renderModal();
    // 스크롤을 모달 상단으로
    const modal = document.getElementById('modal-content');
    if (modal) modal.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeDetail() {
    modalState = null;
    document.getElementById('modal-detail').classList.remove('open');
  }

  function addReview(id) {
    reviewCounts[id] = (reviewCounts[id] || 0) + 1;
    localStorage.setItem(REVIEW_KEY, JSON.stringify(reviewCounts));
    document.getElementById('review-count').textContent = reviewCounts[id];
  }

  // ============================================================
  // §01 Search input — 번호/범위/키워드/서비스/도메인 라벨 검색
  // ============================================================
  (function wireSearch() {
    const input = document.getElementById('qsearch');
    const clearBtn = document.getElementById('qsearch-clear');
    if (!input) return;

    function commit(val) {
      searchQuery = val || '';
      currentPage = 1;
      if (clearBtn) clearBtn.hidden = !searchQuery;
      renderList(getQuestions());
    }

    // 입력 디바운스 (Korean IME composition 중에는 스킵)
    let composing = false, t = null;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; commit(input.value); });
    input.addEventListener('input', () => {
      if (composing) return;
      clearTimeout(t);
      t = setTimeout(() => commit(input.value), 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        input.value = '';
        commit('');
      } else if (e.key === 'Enter') {
        // 디바운스 우회 — 즉시 적용
        clearTimeout(t);
        commit(input.value);
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        commit('');
        input.focus();
      });
    }

    // Cmd/Ctrl + K  →  검색창 포커스
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  })();

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      currentPage = 1;
      renderList(getQuestions());
    });
  });

  document.getElementById('modal-detail').addEventListener('click', (e) => {
    if (e.target.id === 'modal-detail') closeDetail();
  });

  // 키보드 단축키: 모달 열려있을 때 ← / → 로 이전/다음 문제, Esc 닫기
  document.addEventListener('keydown', (e) => {
    if (!modalState) return;
    // 메모 textarea 등 입력 중엔 네비 건너뜀 (사용자가 글 쓰는 중일 수 있음)
    const t = e.target;
    const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
    if (typing && e.key !== 'Escape') return;
    if (e.key === 'ArrowLeft')       { e.preventDefault(); navPrev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); navNext(); }
    else if (e.key === 'Escape')     { closeDetail(); }
  });

  render();
