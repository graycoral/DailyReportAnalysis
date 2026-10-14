# DailyReportAnalysis

- 회사 클라이언트에서 AI 모델이나 외부 AI API를 호출하지 않는다. 예외는 `rag/`의 멀티모달 검색뿐이다: 분석 담당자가 자기 PC에서 직접 켜는 선택 기능이며 EXE에 모델·Python을 넣지 않고, 서비스가 없으면 탭은 안내만 표시한다.
- Windows 비개발자가 Git·Python·Node 설치 없이 실행할 수 있게 유지한다.
- 서버는 loopback에만 바인드한다. 인증 정보는 소스·데이터·로그에 넣지 않는다.
- 데이터 분석과 사실 검증은 게시 단계에서 수행한다. 그래프 관계에는 출처와 근거가 필요하다.
- `data/catalog.json` 변경은 `docs/DATA_CONTRACT.md`를 따른다.
- 원본 보고서 파일과 catalog 변경은 동일 커밋으로 게시한다.
- 의미 있는 검증: `go test ./internal/...`; 배포는 Windows CI 설치·실행 검사를 통과해야 한다.
