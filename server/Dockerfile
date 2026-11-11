# TVAutoPlayer 内容管理服务端
# node:sqlite 需要 Node >= 22.5，因此用 Node 24 的 alpine 精简版
FROM node:24-alpine

# ffmpeg：上传旧封装 MKV 时做无损重封装
# tzdata：时段计划按本地时间计算，缺少时区数据会整体偏移
RUN apk add --no-cache ffmpeg tzdata

ENV NODE_ENV=production \
    PORT=8300 \
    TV_DATA_DIR=/data \
    TV_MEDIA_DIR=/media \
    TZ=Asia/Shanghai

WORKDIR /app/server
COPY . .

# 数据库/密钥与媒体分开两个卷，便于单独备份与直接拷入视频
RUN mkdir -p /data/data /media
VOLUME ["/data", "/media"]

EXPOSE 8300
CMD ["node", "server.js"]
