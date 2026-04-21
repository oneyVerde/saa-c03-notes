# saa-c03-notes

SAA-C03 시험 대비 오답 노트. 스크린샷 기반으로 문제를 축적해 약점을 분석하는 정적 사이트.

## 사이트 개요

- 이 사이트는 **정적 HTML 파일 하나**(`index.html`)로 배포됩니다. 문제 데이터는 **Supabase DB**(`questions` 테이블)에서 매 로그인마다 불러옵니다.
- 새 문제를 추가하려면 Claude에게 스크린샷을 보내 UPSERT JSON을 받아 `bash supabase/upsert.sh <path>`로 DB에 반영합니다. HTML은 건드리지 않아도 됩니다.
- 메모·북마크·복습 횟수는 **Supabase**(로그인 시)와 **`localStorage`**(오프라인 캐시)에 함께 저장됩니다.

## 주요 기능

### §01 Wrong Answers
- 도메인별(Resilient / Performance / Secure / Cost) 필터와 ★ Bookmarked 필터 제공
- 문제 카드 클릭 시 모달에서 옵션·정답·해설·메모를 확인
- 모달 내부 이전/다음 버튼 + 키보드 ←/→ 로 필터 내에서 연속 탐색 가능 (Esc로 닫기)

### Quiz Mode
- 옵션을 클릭하면 단일 정답은 즉시 해설이 공개되고, 복수 정답은 여러 개 체크 후 버튼으로 확인
- 정답과 선택을 비교해 "내 선택 ✓ / 오답" 뱃지를 표시

### Range Accuracy (꺾은선 차트)
- 입력한 문제 번호 구간에서 오답 노트에 기록된 문제의 비율을 계산합니다 (기록 안 된 문제 = 정답으로 간주).
- **균등 분할**: `시작-끝/구간크기` 형식 (예: `1-100/10`) → 자동으로 1-10, 11-20, ... 으로 나눔.
- **비균등 분할**: 콤마로 직접 구간 나열 (예: `1-10, 11-51, 52-102`) → 구간마다 다른 크기 가능. 풀어본 진도가 일정하지 않을 때 유용.
- 구간을 비균등으로 입력하면 진도별 정답률 추세를 꺾은선으로 볼 수 있습니다.

### Service Frequency
- 오답 문제 토픽을 분석해 자주 등장한 AWS 서비스 TOP 6을 표시합니다.
- 칩을 클릭하면 해당 AWS 서비스를 다룬 문제만 §01 리스트에 필터링됩니다.

## 저장소 구조

```
saa-c03-notes/
├── index.html                      # 단일 페이지 앱
├── supabase/
│   ├── 01_schema.sql               # questions 테이블 스키마
│   ├── 02_seed_*.sql               # 초기 시드
│   ├── upsert.sh                   # pending JSON 업서트 스크립트
│   └── pending/                    # (gitignored) 문제 내용 JSON 파일
└── README.md
```

## 로컬 실행

정적 파일이라 별도 빌드 없이 `index.html`을 브라우저로 열면 됩니다. Vercel에 루트째로 배포되며, Supabase 자격증명은 `window.SUPABASE_CONFIG`에 하드코딩된 anon 키로 읽기 전용 접근합니다.
