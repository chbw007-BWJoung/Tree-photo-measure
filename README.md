# 🌳 사진 수목측정

아이폰으로 나무를 찍어 **수고·지하고·수관폭·흉고직경**을 측정하고,
Supabase `tree_measurements` 테이블에 저장하는 웹앱(PWA)입니다.
저장된 값은 기초현황조사표의 **📥 측정값 가져오기**로 같은 No. 행에 채워집니다.

---

## 1. Supabase에서 할 일

### A. 기존 프로젝트를 그대로 쓰는 경우 (권장)
1. Supabase 대시보드 → **Project Settings → API**에서 아래 두 값을 복사합니다.
   - **Project URL** (`https://….supabase.co`)
   - **anon public** 키
2. 테이블과 권한은 그대로 둡니다. 따로 할 일이 없습니다.

### B. Supabase 프로젝트를 새로 만드는 경우
1. **New project**를 만듭니다. 지역은 Northeast Asia (Seoul)로 고르세요.
2. **SQL Editor**에 `supabase/schema.sql` 내용을 붙여 넣고 **Run**을 누릅니다.
3. A의 1번처럼 URL과 anon 키를 복사합니다.
4. 기초현황조사표 `index.html`의 `TM_URL`, `TM_KEY` 두 줄을 새 값으로 바꿉니다.

---

## 2. GitHub에서 할 일

1. **새 저장소를 만듭니다.** 예: `tree-photo-measure`. Public으로 만들어야 무료 Pages를 쓸 수 있습니다.
2. **이 폴더 전체를 올립니다.** 숨김 폴더 `.github`도 함께 올라가야 합니다.
   ```bash
   git init
   git add .
   git commit -m "사진 수목측정 첫 버전"
   git branch -M main
   git remote add origin https://github.com/<아이디>/tree-photo-measure.git
   git push -u origin main
   ```
   웹에서 파일 업로드로 올릴 때는 `.github/workflows/deploy.yml`이 빠지지 않았는지 확인하세요.
3. **Supabase 키를 Secrets에 등록합니다.** 저장소 **Settings → Secrets and variables → Actions**에서 설정합니다.
   - **Secrets** 탭 → New repository secret
     - `VITE_SUPABASE_URL` = Project URL
     - `VITE_SUPABASE_ANON_KEY` = anon 키
   - **Variables** 탭(선택) → `VITE_SURVEY_URL` = 기초현황조사표 전체 주소
     (예: `https://<아이디>.github.io/<조사표저장소>/survey/index.html`)
     이 값은 앱의 ⚙︎ 설정에서도 넣을 수 있습니다.
4. **Pages를 켭니다.** **Settings → Pages → Build and deployment → Source: GitHub Actions**로 바꿉니다.
5. **배포를 실행합니다.** **Actions** 탭에서 "GitHub Pages 배포"가 초록 체크로 끝나면
   `https://<아이디>.github.io/tree-photo-measure/`에서 열립니다.
   Secrets를 push한 뒤에 등록했다면 Actions → 배포 → **Run workflow**로 다시 실행하세요.

---

## 3. 아이폰에 설치

1. 사파리로 위 주소를 엽니다.
2. 하단 **공유** → **홈 화면에 추가**를 누릅니다.
3. 처음 촬영할 때 카메라 권한을 허용합니다.

---

## 현장 사용 순서

1. **📷 사진으로 측정**을 누르고 No.·수종·거리를 입력합니다. No.는 오늘 마지막 번호 + 1로 자동 제안됩니다.
2. **카메라로 촬영**합니다. 1배 렌즈, 세로, 폰을 수평으로 들고 나무 전체가 들어오게 찍으세요.
3. 자동으로 잡힌 점 7개를 확인하고, 필요하면 끌어서 고칩니다.
   - 끄는 동안 4배 돋보기가 나옵니다.
   - 두 손가락으로 확대할 수 있습니다.
   - 점을 누른 뒤 ←→↑↓ 버튼으로 1픽셀씩 옮길 수 있습니다.
   - 흉고 좌우점은 밑동 위 1.2 m 선에 자동으로 고정됩니다.
4. **저장**을 누릅니다. 인터넷이 없으면 폰에 보관했다가 연결되면 자동으로 전송합니다.
5. 조사표에서 **📥 측정값 가져오기**를 누릅니다(홈의 **기초조사표 열기** 버튼으로 바로 열림).

**사진 저장**은 측정점과 결과가 표시된 사진을 남깁니다(증빙용).

---

## 앱을 고친 뒤 다시 배포할 때

- `main`에 push하면 자동으로 배포됩니다.
- 아이폰에 예전 화면이 남아 있으면 `public/sw.js`의 `VERSION`(예: `'v1'` → `'v2'`)을 올려서 다시 push하세요.

## 로컬에서 테스트 (선택)

```bash
cp .env.example .env     # 값 채우기
npm install
npm run dev              # 같은 Wi-Fi의 아이폰에서 http://<PC IP>:5173 접속
```
아이폰 카메라는 https 주소에서만 확실히 동작합니다. 촬영 테스트는 배포된 주소에서 하세요.

## 폴더 구조

```
.github/workflows/deploy.yml   GitHub Pages 자동 배포 (Node 22)
public/                        manifest, 서비스워커(sw.js), 아이콘
src/App.jsx                    홈 화면 (측정 기록 목록, 설정)
src/supabaseClient.js          Supabase 연결 (환경변수)
src/photo-measure/             측정 화면 · 계산 · 오프라인 대기열
supabase/schema.sql            테이블·권한 설정 (새 프로젝트일 때만)
```

## 계산 방식

- **초점거리:** 사진 EXIF의 35mm 환산 초점거리(1배 = 24mm)를 사용합니다. 정보가 없으면 선택한 렌즈 값을 씁니다.
- **투영:** 줄기를 지나는 수직면(거리 D)에 각 점을 투영하고, 입력한 카메라 기울기를 보정합니다.
- **흉고직경:** 원통 접선 보정을 합니다. '거리를 줄기 표면까지 쟀음'을 켜면 반지름을 더해 중심 거리로 환산합니다.
- **기준자:** 길이를 아는 막대를 줄기 옆에 세워 찍으면 거리를 입력하지 않아도 됩니다.
- **자동 인식:** 하늘과 나무의 대비와 색으로 위치를 잡는 오프라인 방식입니다. 배경이 복잡하면 ⚠ 안내가 나오니 점을 직접 맞춰 주세요.
