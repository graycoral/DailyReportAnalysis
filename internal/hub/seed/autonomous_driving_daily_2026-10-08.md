---
theme: default
title: 자율주행 데일리 리포트 2026-10-08
info: 글로벌 자율주행 및 로보택시 신규 동향
class: text-left
highlighter: shiki
transition: slide-left
mdc: true
---

# 자율주행 데일리 리포트

## 2026-10-08

핵심 주제: **Waymo 디트로이트 완전무인 운행 전환**

---

## Executive Summary

- **[신규·미보고] Waymo Detroit:** 10월 6일부터 운전석 안전요원 없이 완전무인 운행을 시작했다. 현재 승객은 Waymo 직원으로 제한되며, 공개 승객 서비스는 검증 후 추진 단계다. [1]
- **[신규] Waymo 안전 프레임워크:** 자연재해·다중차량 사고 등 대형 사건에 대비해 FEMA의 HSEEP를 AV 운영에 맞게 변형한 사고관리 훈련 프레임워크를 공개했다. 실제 사고율이나 허가가 바뀐 것은 아니며, 운영 준비·기관 공조 절차의 표준화 제안이다. [2][3]
- **[신규·미보고] Minneapolis:** Jacob Frey 시장이 로보택시에 운전석 인간 안전요원을 의무화하는 조례를 10월 2일 거부했다. 기존 7대6 의결은 재의결에 필요한 9표에 미달해, 현재 조례는 발효되지 않았다. [4][5]
- **지정 6개 기업 L4 점검:** Uber, Avride, Bolt, Mobileye, 카카오모빌리티, 쏘카에서 전일 보고 이후 신규 driver-out 운행·허가·차량 투입·계약 실행 변화는 확인되지 않았다. [6]~[11]
- **May Mobility [중복]:** 신규 확인 사항 없음. Atlanta 안전요원 제거, Arlington 상용 개시, 신규 증차 또는 SPAC 거래 종결 공시는 확인되지 않았다. [12]~[15]

---

## 주요 신규 업데이트

### [신규·미보고] Waymo, Detroit에서 직원 대상 완전무인 운행

- **실제 달성:** 2026년 10월 6일 Detroit 도심과 Corktown, Midtown, Hamtramck, Indian Village 인근에서 운전석 안전요원 없는 운행을 시작했다. [1]
- **승객 범위:** 현재 호출·탑승은 Waymo 직원으로 제한된다. 일반 시민 대상 유료 서비스 개시는 아직 확인되지 않았다. [1]
- **이전 단계 대비 변화:** 사람 운전자가 탑승한 시험에서 rider-only 운행으로 넘어간 기술·운영 단계 변화다.
- **향후 계획:** Waymo는 안전 검증 후 대중에게 개방하고 Metro Detroit로 범위를 점진 확대하겠다고 밝혔다. 구체적 공개일·차량 수·요금은 공개하지 않았다. [1]

**Reference:** [ClickOnDetroit, 2026-10-06](https://www.clickondetroit.com/news/local/2026/10/06/waymo-begins-fully-autonomous-driving-in-detroit-what-to-know/)

---

## 규제·안전

### [신규] Waymo, AV 사고관리 훈련 프레임워크 공개

- 자연재해, 복잡한 교통사건, 여러 AV에 영향을 주는 대형 상황을 대상으로 한다. [2]
- FEMA의 **Homeland Security Exercise and Evaluation Program(HSEEP)**을 AV 운영에 맞게 적용해 계획·활성화·대응·평가 단계를 제시한다. [2][3]
- 훈련을 형성형, 교육형, 종합형, 확인형으로 구분하며 AV 개발사, 운영 파트너, 긴급대응기관, 정부 간 역할·통신을 사전에 검증하도록 한다. [2][3]
- **해석 범위:** 회사 중립적 운영 가이드 제안이며, 규제기관 승인이나 Waymo 차량의 신규 ODD 확대를 의미하지 않는다.

**References:** [Waymo, 2026-10-07](https://waymo.com/blog/2026/10/incident-management-exercises/) · [논문 원문](https://arxiv.org/abs/2609.04777)

### [신규·미보고] Minneapolis 인간 안전요원 의무 조례 거부

- 시의회는 10월 1일 로보택시에 운전면허를 가진 유급 인간 안전요원을 운전석에 두도록 하는 조례를 7대6으로 통과시켰다. [5]
- Frey 시장은 10월 2일 이를 거부했다. 시장은 인간 탑승 의무 대신 긴급대응, 개인정보, 교통집행, 책임·보험, 데이터 보고를 규율해야 한다는 입장이다. [4][5]
- 재의결에는 9표가 필요해 기존 찬성 7표만으로는 거부권을 뒤집을 수 없다. 따라서 2027년 10월 시행 예정이던 의무는 현재 발효되지 않았다. [4]

**References:** [CBS Minnesota, 2026-10-02](https://www.cbsnews.com/minnesota/news/minneapolis-mayor-jacob-frey-vetoes-driverless-rideshare-ordinance/) · [FOX 9, 2026-10-02](https://www.fox9.com/news/minneapolis-mayor-robotaxi-regulation-veto-doesnt-make-sense-oct-2-2026)

---

## 기업·지역별 상세 내용

### 지정 6개 기업의 레벨 4 점검

| 기업 | 2026-10-08 점검 결과 | 확인 범위 |
|---|---|---|
| **Uber** | **신규 확인 사항 없음** | 신규 driver-out 운행, 시험·상용 허가, 지역·차량 규모 또는 파트너 계약 실행 변화 미확인. [6] |
| **Avride** | **신규 확인 사항 없음** | Dallas 운행의 안전요원 제거, 지오펜스 확대, 증차·허가 변화 미확인. [7] |
| **Bolt** | **신규 확인 사항 없음** | Lucid·Pony.ai·Stellantis L4 계획 이후 실제 시험 개시·무인 전환·상용 운행 변화 미확인. [8] |
| **Mobileye** | **신규 확인 사항 없음** | Mobileye Drive 기반 로보택시의 신규 driver-out, 허가, 상용 서비스 개시 미확인. [9] |
| **카카오모빌리티** | **신규 확인 사항 없음** | 신규 L4 허가·무인 전환·운영지역·차량 규모 변화 미확인. [10] |
| **쏘카** | **신규 확인 사항 없음** | APEX Mobility 로드맵 이후 실제 L4 운행·허가·차량 투입 변화 미확인. [11] |

---

## 기술·공급망

- Waymo Detroit의 rider-only 전환은 기존 ADS의 신규 지역 검증 단계 진전이다. 차량 수, 센서·컴퓨팅 구성 변화, 공급계약은 공개되지 않았다. [1]
- 이번 점검 기간에 확인된 신규 L4 센서·컴퓨팅 양산 계약이나 핵심 부품 공급망 변화는 없다.

---

## May Mobility 심층 조사

### [중복] 운영·기술·사업 현황

이전 보고: **2026-09-21, 09-23~25, 09-28~30, 10-01~07**. **신규 확인 사항 없음.** 10월 7일 이후 회사 공식 뉴스와 SEC 공개자료에서 신규 지역 개시, 증차, driver-out 전환, 파트너 계약 실행 또는 SPAC 종결 공시는 확인되지 않았다. [12]~[15]

- **[중복] 실제 운영:** 공개된 미국 상용 운영 지역은 Atlanta, Grand Rapids, Eden Prairie다. Atlanta Lyft 서비스는 출범 당시 안전요원이 탑승했으며, 안전요원 제거 공시는 없다. [12][15]
- **[중복] 누적 실적:** 회사가 제시한 누적 상업용 탑승은 **55만 회 이상**, 자율주행은 **110만 마일 이상**, 미국 driver-out 전환은 3개 도시다. 누적 수치는 현재 모든 노선이 무인이라는 뜻이 아니다. [13]
- **[중복] 기술·ODD:** 라이다·레이더·카메라를 사용하며, 5세대 ADS는 세계모델과 다중정책 추론을 결합한다. 회사는 200ms마다 수백 개의 가능한 미래를 평가한다고 설명하지만, 지역별 날씨·속도·도로 조건의 전체 ODD는 공개하지 않았다. [14]
- **[중복] 계획과 실행 구분:** Uber Arlington 서비스 목표는 2026년 4분기~2027년 1분기이나 실제 개시는 확인되지 않았다. [13]
- **[중복] 사업모델:** 파트너가 차량 소유·정비·차고지·현장운영을 맡고 May가 ADS를 공급하는 Autonomy-as-a-Service 전환을 제시했다. 지역별 전환 완료 여부는 공개되지 않았다. [13]
- **[중복] 거래:** SPAC 결합은 추정 기업가치 약 **14억달러**, 최대 총조달 **3.37억달러**, 확약 PIPE **1.2억달러**로 발표됐으나 거래 종결과 Nasdaq 상장은 아직 확인되지 않았다. [13]
- **[중복] 현대차 연관성:** 확인한 회사·SEC 자료에서 현대차와의 직접 투자, 차량공급, 사업제휴는 확인되지 않았다. [12]~[14]

---

## Reference

1. ClickOnDetroit, “Waymo begins fully autonomous driving in Detroit,” 2026-10-06  
   https://www.clickondetroit.com/news/local/2026/10/06/waymo-begins-fully-autonomous-driving-in-detroit-what-to-know/
2. Waymo, “Preparing for the Unexpected: A New Framework for AV Incident Management Exercises,” 2026-10-07  
   https://waymo.com/blog/2026/10/incident-management-exercises/
3. Fraade-Blanar et al., “On Being Prepared: Automated Vehicle Incident Management Exercise Practices,” 2026  
   https://arxiv.org/abs/2609.04777
4. CBS Minnesota, “Mayor Jacob Frey vetoes driverless rideshare ordinance,” 2026-10-02  
   https://www.cbsnews.com/minnesota/news/minneapolis-mayor-jacob-frey-vetoes-driverless-rideshare-ordinance/
5. FOX 9, “Mayor Frey vetoes city council Waymo regulation,” 2026-10-02  
   https://www.fox9.com/news/minneapolis-mayor-robotaxi-regulation-veto-doesnt-make-sense-oct-2-2026
6. Uber, Autonomous Newsroom  
   https://www.uber.com/us/en/newsroom/autonomous/
7. Avride, Official Site  
   https://www.avride.ai/
8. Bolt, Autonomous Solutions  
   https://bolt.eu/en/blog/category/autonomous-solutions/
9. Mobileye, Newsroom  
   https://www.mobileye.com/news/
10. 카카오모빌리티, 뉴스룸  
    https://www.kakaomobility.com/newsroom
11. 쏘카·APEX Mobility, 자율주행 상용화 로드맵  
    https://www.socarcorp.kr/blog/772
12. May Mobility, Company News  
    https://maymobility.com/posts/type/company-news/
13. ACP Holdings / May Mobility, SEC-filed transaction press release, 2026-09-16  
    https://www.sec.gov/Archives/edgar/data/2111542/000121390026100367/ea030470201ex99-1.htm
14. May Mobility, “New AV Architecture,” 2026-05-20  
    https://maymobility.com/posts/may-mobility-launches-new-av-architecture/
15. Lyft / May Mobility, Atlanta launch  
    https://www.lyft.com/blog/posts/lyft-and-may-mobility-launch-autonomous-vehicles-in-atlanta

---

## 작성·제작 기준

- 10월 7일까지 보고한 일반 기업의 동일 사실은 제외했다. Waymo Detroit와 Minneapolis veto는 이전 리포트에 누락된 상태 변화이므로 `[신규·미보고]`로 표시했다.
- May Mobility만 요청에 따라 기존 핵심 사실을 `[중복]`으로 재기재했다.
- 유료 기사는 사용하지 않았다.
- **Slidev 직접 PPTX 변환은 실행 환경에 Slidev 패키지가 없어 지원되지 않았다.** 이 파일은 `---` 구분을 포함한 Slidev 호환 Markdown이며, 함께 첨부한 PPTX는 동일 핵심 내용을 별도 프레젠테이션 도구로 제작한 대체 출력물이다.
