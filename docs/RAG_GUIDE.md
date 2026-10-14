# 멀티모달 검색 (실험 기능) 안내

PDF 페이지를 **이미지 그대로** 임베딩해서 문장으로 찾는 기능입니다. 표·차트·슬라이드처럼 글자 추출이 잘 안 되는 문서도 검색할 수 있습니다. 임베딩 모델은 Google의 `embeddinggemma-2`를 **내 PC에서 직접** 실행하며 외부 AI 서비스를 호출하지 않습니다.

> **이 기능은 기본 배포본에 포함되지 않습니다.** AV Report Hub의 원칙은 "사용자 PC에서 AI를 실행하지 않는다"입니다. 멀티모달 검색은 분석 담당자가 자기 PC에서 별도로 켜는 선택 기능이고, 서비스를 실행하지 않은 PC에서는 탭에 안내문만 표시됩니다. 검색·타임라인·그래프 등 기본 화면과 GitHub 동기화에는 아무 영향이 없습니다.

## 1. 구조

```
AV Report Hub (Go EXE)  ──프록시──▶  rag/rag_server.py (Python, 127.0.0.1)  ──▶  embeddinggemma-2 (CPU)
        │                                     │
   🧪 멀티모달 검색 탭           %LOCALAPPDATA%\AVReportHub\rag\index  (PDF 사본·페이지 이미지·벡터, 암호화 없음)
```

- Go 앱에는 모델도 Python도 들어 있지 않습니다. `rag-service.json` 파일로 서비스 주소와 키를 찾아 요청을 넘길 뿐입니다.
- 서비스는 루프백(127.0.0.1)에만 열리고, 앱이 보내는 키가 없는 요청은 거부합니다.
- 오디오 인코더는 불러오지 않습니다. 텍스트+이미지 구성으로 약 4.4억 파라미터입니다.

## 2. 준비 (한 번만)

필요한 것: Windows 10/11 64비트, **Python 3.10** (python.org 배포판), 인터넷(모델 내려받기 약 1~2GB), 디스크 5GB, 메모리 8GB 이상.

```powershell
cd DailyReportAnalysis\rag
py -3.10 -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python -m pip install -r requirements.txt
```

> Miniconda의 Python 3.12로 가상환경을 만들면 이 PC에서는 `torch` 로딩이 `WinError 1114 (c10.dll)`로 실패했습니다. python.org의 3.10을 쓰세요.

모델을 받고 동작을 확인합니다.

```powershell
.\.venv\Scripts\python test_embed.py
```

처음 실행하면 Hugging Face에서 모델을 내려받습니다(Apache 2.0, 로그인 불필요). 끝나면 아래 항목이 출력됩니다.

- 모델 불러오는 시간, 파라미터 수, 임베딩 차원(768)
- `docs/` 폴더 첫 PDF의 첫 페이지를 이미지로 바꿔 임베딩한 시간
- 그 페이지와 문장 3개(관련 2, 무관 1)의 코사인 유사도

`docs/` 폴더에 PDF가 없으면 최신 리포트 본문으로 `docs/sample-from-….pdf`를 만들어 대신 사용합니다. 다른 폴더를 쓰려면 `--docs 경로`를 붙입니다.

## 3. 사용

1. 서비스를 켭니다. 창을 닫으면 꺼집니다.
   ```powershell
   cd DailyReportAnalysis\rag
   .\.venv\Scripts\python rag_server.py
   ```
   "model ready …", "listening on http://127.0.0.1:…"가 보이면 준비된 것입니다.
2. AV Report Hub를 실행하고 **🧪 멀티모달 검색** 탭을 엽니다. 서비스를 나중에 켰다면 "다시 확인"을 누릅니다.
3. **보여 줘** 버튼: 모델 정보, 첫 페이지 임베딩 시간, 문장 유사도를 표로 보여줍니다. "다시 계산"은 처음부터 다시 잽니다.
4. **PDF 올리기**: 끌어다 놓거나 눌러서 선택합니다. 올리기 전에 경고 창이 뜹니다(아래 참고). 페이지마다 이미지로 바꿔 임베딩하므로 CPU에서는 페이지당 수 초 걸립니다.
5. **검색**: 문장을 입력하면 가장 비슷한 페이지 6개가 썸네일과 유사도로 나옵니다. 썸네일을 누르면 오른쪽에 크게 표시됩니다.
6. 색인된 문서는 목록에서 **삭제**할 수 있습니다. 사본·이미지·벡터가 함께 지워집니다.

## 4. 올리기 전 경고 창에 대해

PDF를 올릴 때마다 아래 내용을 확인하는 창이 뜹니다. "이 세션에서는 다시 묻지 않기"를 켜면 앱을 다시 열 때까지 생략됩니다.

- PDF는 이 PC의 임베딩 서비스로 전송되어 페이지 이미지와 벡터로 바뀝니다.
- 사본과 변환 결과는 `%LOCALAPPDATA%\AVReportHub\rag\index`에 **암호화 없이** 저장됩니다. 「내 자료」 탭의 PDF처럼 Windows 계정으로 암호화되지 않습니다.
- 저장 폴더는 Git 저장소 밖에 있으며, `RAG_INDEX`·`RAG_DOCS`로 저장소 안을 지정하면 서비스가 시작을 거부합니다. 예전 위치 `rag/index/`에 남은 색인은 첫 실행 때 옮겨집니다.
- 이 폴더가 OneDrive 같은 동기화·백업 대상이면 **외부로 유출될 수 있습니다**. 그런 경로는 막지 못합니다.
- 회사 정책상 반출 금지 문서는 올리지 마세요.

## 5. 「내 자료」와의 차이

| | 🔒 내 자료 | 🧪 멀티모달 검색 |
| --- | --- | --- |
| 목적 | 리포트에 PDF·메일을 붙여 두기 | PDF 페이지를 내용으로 찾기 |
| 저장 | DPAPI 암호화, `%LOCALAPPDATA%\AVReportHub\docs\pdf` | 평문, `%LOCALAPPDATA%\AVReportHub\rag\index` |
| 검색 | 파일 이름 | 페이지 이미지 임베딩 (문장으로) |
| AI 실행 | 없음 | 내 PC에서 embeddinggemma-2 |
| 배포본 포함 | 예 | 아니오 (서비스를 켠 PC만) |

## 6. 문제 해결

| 증상 | 조치 |
| --- | --- |
| 탭에 "서비스가 실행 중이 아닙니다" | `rag_server.py`가 켜져 있는지, 같은 Windows 계정인지 확인. `%LOCALAPPDATA%\AVReportHub\rag-service.json`이 있어야 합니다 |
| `WinError 1114` c10.dll | Miniconda Python으로 만든 가상환경입니다. python.org 3.10으로 다시 만드세요 |
| 모델 내려받기 실패 | 프록시·방화벽에서 `huggingface.co` 허용. 처음 한 번만 내려받고, 이후에는 캐시된 모델을 먼저 써서 외부 접속 없이 시작합니다(문서는 전송하지 않음, 사용 통계 전송 끔) |
| 색인이 너무 느림 | CPU 전용입니다. 환경변수 `RAG_RENDER_SCALE=1.0`으로 해상도를 낮추면 빨라집니다 |
| 첫 페이지 유사도가 모두 낮음 | 스캔 품질이나 페이지 내용이 적을 때 그렇습니다. 문장을 더 구체적으로 쓰세요 |

서비스 로그는 콘솔에만 출력되며 검색 문장이나 파일 내용은 기록하지 않습니다.
