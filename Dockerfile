# 1. Node.js 이미지를 베이스로 사용
FROM node:20-slim

# 2. FFmpeg 설치 (Debian 패키지 매니저 이용)
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 3. 앱 디렉토리 생성
WORKDIR /usr/src/app

# 4. 의존성 설치
COPY package*.json ./
RUN npm install

# 5. 소스 복사
COPY . .

# 6. 포트 개방
EXPOSE 3000

# 7. 서버 실행
CMD ["node", "index.js"]