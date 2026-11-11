---
theme: default
title: "자율주행 데일리 리포트 2026-11-12"
info: "Autoware AutoE2E 공개와 L4 검증 단계"
fonts:
  sans: Noto Sans CJK KR
---

# Executive Summary
## 2026-11-12 · Autoware AutoE2E 공개와 L4 검증 단계

- **[신규·기술 공개] Autoware Foundation·TIER IV**: 11월 11일 7,990만 파라미터의 카메라 우선 종단간 주행 모델 AutoE2E v1.0과 소스·체크포인트를 공개했다. Apache 2.0 라이선스로 연구·상업 이용이 가능하다. [R1][R2][R3][R4]
- **단계 구분**: AutoE2E는 Autoware에 통합돼 공개 데이터 기반 open-loop 평가를 마쳤지만, 실차 closed-loop 시험은 진행 중이고 도로 시험은 2027년 계획이다. 공개 자료는 현재 L4 상용·무인 운행 달성을 입증하지 않는다. [R1][R2]
- **성능·구성**: 공개된 Reactive Model은 6개 카메라 입력으로 10Hz에서 6.4초 궤적을 생성하며, KITScenes-Multimodal 검증에서 3초 ADE 0.744m를 기록했다. World Model과 Reasoning Model은 아직 개발 중이다. [R1][R2]
- **지정 6개사**: Uber·Avride·Bolt·Mobileye·카카오모빌리티·쏘카에서 이전 보고 이후 실질적인 신규 L4 상태 변화는 확인되지 않았다. [R5][R6][R7][R8][R9][R10]
- **May Mobility [중복]**: 이전 보고 2026-11-11 · Investor Day 2026-11-12 행사 전 · 신규 확인 사항 없음. [R11][R12][R14]

확인 기준: 2026-11-12 07:32 한국시간. 이전 발송본 및 공개 저장소 보고서와 비교해 May Mobility를 제외한 동일 사건·수치의 재보도를 제외했다.

---

# 주요 신규 업데이트
## [신규] AutoE2E v1.0 공개

- **보도·공개일**: 2026-11-11. **예정일**: 2027년 추가 도로 시험 계획. [R1][R2]
- **당사자**: Autoware Foundation Robotaxi Working Group과 후원사 TIER IV. [R1][R2]
- AutoE2E v1.0은 7,990만 파라미터의 Reactive Model, 학습 코드와 체크포인트를 Apache 2.0으로 공개했고 Autoware 통합을 완료했다. [R1][R2][R3][R4]
- KITScenes-Multimodal open-loop 검증에서 3초 ADE 0.744m로 비교된 8개 open-weight 구성 중 2위를 기록했다. 이는 기록 데이터에 대한 궤적 오차이며 실도로 안전 성능이나 L4 달성 지표가 아니다. [R1]
- 실차 closed-loop 시험은 진행 중이고 World Model·Reasoning Model도 개발 중이다. 공개된 사실만으로 상용 robotaxi 배치, 안전요원 제거 또는 L4 허가 취득을 추정하지 않는다. [R1][R2]

출처: [Autoware Foundation, 2026-11-11][R1] · [TIER IV, 2026-11-11][R2]

---

# 기업/지역별 상세 내용
## Autoware Foundation·TIER IV

- **모델 구조**: Reactive Model은 6개 카메라 영상을 조감 표현으로 융합해 10Hz에서 향후 6.4초의 가속·조향 궤적을 생성한다. [R1]
- **센서·컴퓨팅**: 카메라 단독 구성을 지원하고 LiDAR·radar 안전 계층과 결합할 수 있다. 7,990만 파라미터의 경량 설계는 자동차 SoC 최적화 대상이며, 실제 배치 성능·자원 요구량은 플랫폼별 검증이 남아 있다. [R1][R2]
- **개발 상태**: v1.0에 포함된 것은 Reactive Model이며 World Model과 언어 비사용 Reasoning Model은 개발 중이다. 실차 closed-loop 시험과 2027년 도로 시험은 계획·진행 단계다. [R1][R2]
- **아직 확인되지 않은 것**: L4 상용 운행 허가, 무인 승객 서비스, 적용 차량·지역·차량 규모와 양산 일정은 공개 자료에서 확인되지 않았다. [R1][R2]

---

# 지정 6개사 L4 점검

| 기업 | 이전 보고 이후 확인 결과 | 확인 출처 |
|---|---|---|
| Uber | 신규 확인 사항 없음 | Uber Autonomous 공식 뉴스룸 [R5] |
| Avride | 신규 확인 사항 없음 | Avride 공식 사이트 [R6] |
| Bolt | 신규 확인 사항 없음 | Bolt Autonomous Solutions 공식 블로그 [R7] |
| Mobileye | 신규 확인 사항 없음 | Mobileye 공식 뉴스 [R8] |
| 카카오모빌리티 | 신규 확인 사항 없음 | 카카오모빌리티 공식 뉴스룸 [R9] |
| 쏘카 | 신규 확인 사항 없음 | 쏘카 공식 블로그 [R10] |

---

# May Mobility 심층 점검
## [중복] 이전 보고 2026-11-11 · Investor Day 2026-11-12 행사 전 · 신규 확인 사항 없음

- **실제 서비스 지역**: Atlanta·Eden Prairie·Grand Rapids 등 기존 공개 서비스 지역의 신규 개통·종료는 확인되지 않았다. California DMV 명단에서 May Mobility는 운전자 동승 시험 허가 보유자로 확인되며 driverless test·deployment 명단에는 없다. [R14][R18]
- **나고야 계획**: NTT Mobility가 발표한 3대·5개 승하차 지점 실증 계획은 기존 사실이며, 안전요원 없는 상용 개시는 확인되지 않았다. [R16]
- **현대차 연관성**: 이번 확인 범위에서 Hyundai Motor Group과 May Mobility 간 신규 직접 계약·투자·차량 공급 관계는 확인되지 않았다. 공개되지 않은 관계를 추정하지 않는다. [R11][R18]

---

# May Mobility 심층 점검
## 안전요원·무인 수준과 기술·ODD

- **[중복] 안전요원·무인 수준**: Atlanta 공개 지침은 Safety Operator가 탑승하는 운행을 전제로 하며, California DMV에서도 운전자 없는 시험·배치 허가는 확인되지 않았다. [R14][R17]
- **[중복] ROADS**: 국방혁신부 프로그램은 차내 안전요원·원격 지원·안전정지를 포함한 Fort Benning 파일럿 계획 단계다. driver-out 개시 자료는 없다. [R13]
- **[중복] 기술·ODD**: May Mobility는 MPDM 기반 의사결정과 예측 모델을 설명하지만, 군 기지 파일럿의 세부 속도·기상·노선 ODD는 공개 자료에서 확인되지 않았다. [R13]
- **신규 확인 사항 없음**: 2026-11-11 보고 이후 안전요원 제거, 무인 허가 취득, 신규 ODD 확대를 확인할 공식 자료가 없다. [R11][R13][R14]

---

# May Mobility 심층 점검
## 차량·운영 실적과 투자·SPAC 일정

- **[중복] 차량·운영 실적**: 공개 투자자료 기준 55만 회 초과 상업 승차, 110만 마일, driver-out 배치 3건이 제시됐으나 모든 서비스 지역이 무인이라는 뜻은 아니다. [R15][R18]
- **[중복] 사업모델**: 파트너가 차량·차고·유지보수를 담당하고 May Mobility가 ADS를 제공하는 AaaS 구조가 제시됐다. [R18]
- **[중복] 투자·SPAC**: 거래 발표 기준 기업가치 약 14억 달러, 최대 3억3,700만 달러 조달 가능성, 2027년 1분기 거래 종결 목표가 제시됐다. 이는 조건부 계획이며 종결 완료가 아니다. [R15][R18]
- **[중복] 일정**: Investor Day는 2026-11-12 15:00~16:30 ET 예정이며, 2026-11-12 07:32 한국시간 확인 시점에는 행사 전이다. [R11][R12]
- **신규 확인 사항 없음**: 이전 보고 2026-11-11 이후 투자 조건 변경, 상장 완료 또는 신규 자금 유입은 확인되지 않았다. [R11][R12][R15]

---

# 규제·안전

- 해당 없음

---

# 기술·공급망

- AutoE2E 소스와 v1.0 체크포인트는 Apache 2.0으로 공개돼 연구·상업 이용과 자체 데이터 재학습·미세조정이 가능하다. [R1][R3][R4]
- 카메라 우선 Reactive Model은 7,990만 파라미터로, 자동차 SoC에서의 계산량·전력·비용 최적화를 전제로 설계됐다. 실제 플랫폼별 성능과 자원 요구량은 아직 평가 대상이다. [R1][R2]
- TIER IV는 Autoware 2.0에서 AutoE2E 외에도 20억 파라미터 NVIDIA Alpamayo 2 Edge의 Autoware 통합을 완료했다고 밝혔다. AutoE2E는 NVIDIA 외 컴퓨팅 플랫폼에서도 실행 가능하도록 개발됐다. [R2]
- 이번 공개는 소프트웨어·모델 공급망의 실행된 변화이지만, L4 상용화·무인 서비스 개시·차량 양산은 아직 확인되지 않았다. [R1][R2]

---

# Reference
## R1–R4

- [R1] Autoware Foundation, AWF Robotaxi WG releases AutoE2E, an open-source end-to-end AI model designed to scale from L2++ to L4 autonomy, 2026-11-11: https://autoware.org/autoware-foundation-and-tier-iv-join-forces-to-releases-autoe2e-an-open-source-ai-model-for-end-to-end-autonomy/
- [R2] TIER IV, TIER IV unveils end-to-end autonomous driving adaptable to map information and sensor configurations, 2026-11-11: https://tier4.co.jp/en/updates/press-release/20261111-tieriv-unveils-e2e-autonomous-driving
- [R3] Autoware Foundation, AutoE2E source code, 2026-11-11: https://github.com/autowarefoundation/auto_e2e
- [R4] Autoware Foundation, AutoE2E v1.0 checkpoints, 2026-11-11: https://huggingface.co/AutowareFoundation/auto_e2e

---

# Reference
## R5–R8

- [R5] Uber, Autonomous 공식 뉴스룸, 2026-11-12 확인: https://www.uber.com/us/en/newsroom/autonomous/
- [R6] Avride, 공식 사이트, 2026-11-12 확인: https://www.avride.ai/
- [R7] Bolt, Autonomous Solutions 공식 블로그, 2026-11-12 확인: https://bolt.eu/en/blog/category/autonomous-solutions/
- [R8] Mobileye, 공식 뉴스, 2026-11-12 확인: https://www.mobileye.com/news/

---

# Reference
## R9–R12

- [R9] 카카오모빌리티, 공식 뉴스룸, 2026-11-12 확인: https://www.kakaomobility.com/newsroom/news
- [R10] 쏘카, 공식 블로그, 2026-11-12 확인: https://www.socarcorp.kr/blog
- [R11] May Mobility, Investors — Latest News: Investor Day on November 12, 2026-11-09: https://maymobility.com/investors
- [R12] U.S. SEC, May Mobility Investor Day and PIPE Announcement — Form 425, 2026-11-09: https://www.sec.gov/Archives/edgar/data/2111542/000121390026117700/ea031158603-425_acphold.htm

---

# Reference
## R13–R16

- [R13] May Mobility, Forterra and May Mobility Advance to Phase III of DIU's ROADS Challenge, 2026-11-05: https://maymobility.com/posts/forterra-and-may-mobility-advance-to-phase-iii-of-dius-roads-challenge-bringing-autonomous-rides-to-soldiers-on-military-bases/
- [R14] California DMV, Autonomous Vehicle Testing Permit Holders, 2026-11-05: https://www.dmv.ca.gov/portal/vehicle-industry-services/autonomous-vehicles/autonomous-vehicle-testing-permit-holders/
- [R15] U.S. SEC, May Mobility Transaction Announcement Exhibit 99.1, 2026-10-21: https://www.sec.gov/Archives/edgar/data/2111542/000121390026100367/ea030470201ex99-1.htm
- [R16] NTT Mobility, 나고야 자율주행 모빌리티 서비스 실증, 2026-08-12: https://www.ntt-mobility.com/news/20260812/newsrelease-260812/

---

# Reference
## R17–R18

- [R17] May Mobility, First Responder Interaction Plan — Atlanta, 2026-11-12 확인: https://maymobility.com/first-responders/frip-atlanta-georgia
- [R18] U.S. SEC, May Mobility Investor Presentation Exhibit 99.2, 2026-10-21: https://www.sec.gov/Archives/edgar/data/2111542/000121390026100367/ea030470201ex99-2.htm

[R1]: https://autoware.org/autoware-foundation-and-tier-iv-join-forces-to-releases-autoe2e-an-open-source-ai-model-for-end-to-end-autonomy/
[R2]: https://tier4.co.jp/en/updates/press-release/20261111-tieriv-unveils-e2e-autonomous-driving
[R3]: https://github.com/autowarefoundation/auto_e2e
[R4]: https://huggingface.co/AutowareFoundation/auto_e2e
[R5]: https://www.uber.com/us/en/newsroom/autonomous/
[R6]: https://www.avride.ai/
[R7]: https://bolt.eu/en/blog/category/autonomous-solutions/
[R8]: https://www.mobileye.com/news/
[R9]: https://www.kakaomobility.com/newsroom/news
[R10]: https://www.socarcorp.kr/blog
[R11]: https://maymobility.com/investors
[R12]: https://www.sec.gov/Archives/edgar/data/2111542/000121390026117700/ea031158603-425_acphold.htm
[R13]: https://maymobility.com/posts/forterra-and-may-mobility-advance-to-phase-iii-of-dius-roads-challenge-bringing-autonomous-rides-to-soldiers-on-military-bases/
[R14]: https://www.dmv.ca.gov/portal/vehicle-industry-services/autonomous-vehicles/autonomous-vehicle-testing-permit-holders/
[R15]: https://www.sec.gov/Archives/edgar/data/2111542/000121390026100367/ea030470201ex99-1.htm
[R16]: https://www.ntt-mobility.com/news/20260812/newsrelease-260812/
[R17]: https://maymobility.com/first-responders/frip-atlanta-georgia
[R18]: https://www.sec.gov/Archives/edgar/data/2111542/000121390026100367/ea030470201ex99-2.htm
