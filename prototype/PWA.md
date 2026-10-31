# 설치형 웹 앱 시험

`index.html`과 `live.html`은 같은 Web App Manifest를 사용한다. Android Chrome에서 **홈 화면에 추가/앱 설치** 후 홈 화면 아이콘으로 실행하면 `standalone` 창에서 주소창과 탭 없이 열린다. 브라우저 탭에서 링크를 열면 여전히 주소창과 탭이 보이는 것이 정상이다.

Z Fold8 로컬 시험: PC에서 `python -m media.server --port 8000`을 실행하고, USB 디버깅이 허용된 기기에서 `adb reverse tcp:8000 tcp:8000`을 설정한다. 휴대폰 Chrome의 `http://127.0.0.1:8000/prototype/index.html`을 설치한 뒤 **홈 화면 아이콘으로 재실행**해야 표시 모드를 확인할 수 있다. 오프라인 버전만 시험하는 서버이며 실제 Muse/음성 통합 서버는 `python -m src.server`다.

이 설치는 현재 PC의 로컬 서버에 의존한다. USB를 빼거나 서버를 끄면 실제 동화 API는 동작하지 않으며, 설치형 화면에는 연결 안내가 표시된다. 독립 사용을 위한 배포에는 서버 호스팅, 인증·저장, HTTPS 도메인과 기기별 음성·카메라 검증이 필요하다. PWA 설치는 Android APK나 iPad TestFlight 배포 완료를 뜻하지 않는다.
