# 분석 완료 데이터 계약 · schema_version 1

클라이언트는 추론하지 않습니다. 게시자는 사실·중복·상태·관계를 검증하고 데이터를 준비합니다.

## catalog.json

- `schema_version`: 현재 `1`.
- `published_at`: ISO 8601 게시 시각, 한국시간은 `+09:00`.
- `reports[]`: 고유 `id`, `date` (보고일), `title`, `summary`, `companies[]`, `tags[]`, `body_markdown`, `sources[]`, `attachments[]`.
- `events[]`: 고유 `id`, `date` (사건 발생/예정일), `title`, `status`, `report_id`, `detail`, `companies[]`, `sources[]`.
- `entities[]`: 고유 `id`, 표시 이름 `label`, `kind` (기업/지역/인물/사건 등).
- `relations[]`: 고유 `id`, `from`, `to` (entity ID), `label`, `status`, `report_id`, `evidence`, `sources[]`.
- `related[]`: `from`, `to` (report ID), `reason` (같은 사건의 후속 보도 등).

`sources`의 원소는 `{ "title": "출처 설명", "url": "https://..." }`입니다.

`attachments`의 원소는 `{ "name": "report.md", "path": "data/reports/2026-10-14/report.md", "sha256": "64자리 소문자 SHA-256" }`입니다. 경로는 `data/reports/` 안에 있어야 합니다. 경로 이동 표현은 허용하지 않습니다.

## 사실과 상태

1. 미래의 운영 개시·퇴사·투자 종결일은 `status: "계획"`으로 둡니다. 회사가 계획을 발표한 사실과 실제 달성을 구별합니다.
2. 관계에는 근거 문장·출처·리포트를 반드시 연결합니다. 단순 동시 언급으로 제휴 관계를 만들지 않습니다.
3. 같은 기업의 별개 사건은 `related`에 근거 없이 연결하지 않습니다. 앱은 별도의 태그 일치 목록을 표시합니다.
4. 중복 예외가 있는 May Mobility는 요약과 본문에 `[중복]`, `[중복·추가 확인]`, `[신규]`를 일관되게 넣고, 신규 확인이 없으면 명시합니다.
5. 유료 원문에 접근하지 못했으면 `[유료 기사][원문 미확인]`과 보완 출처를 기록합니다.
6. 보고일과 사건 발생일을 혼동하지 않습니다. 처음 발견한 오래된 사건도 발생 날짜를 정확히 기록합니다.

## 게시와 버전

앱은 먼저 브랜치의 커밋 SHA를 확인하고 해당 SHA에서 catalog와 첨부를 읽습니다. 일부 파일만 게시된 상태를 피하도록 변경을 한 커밋으로 묶습니다. 데이터 검증에 실패하면 이전 스냅샷을 보존합니다.

클라이언트에 전달하는 누적 catalog는 현재 25 MiB 이하로 제한합니다. 이 규모를 넘기기 전에 월별 분할과 별도 색인 버전을 설계합니다. 개별 첨부는 90 MiB 이하입니다.

실행 파일의 초기 자료를 갱신할 때는 `data/catalog.json`을 `internal/hub/seed/catalog.json`에도 반영하고, 오프라인 첨부가 필요하면 동일한 파일을 `internal/hub/seed/`에 둡니다. 일반 일일 게시에는 EXE 재빌드가 필요하지 않습니다.
