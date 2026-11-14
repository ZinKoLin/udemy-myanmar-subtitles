FROM mcr.microsoft.com/playwright:v1.64.1-noble
USER root
RUN apt-get update && apt-get install -y --no-install-recommends x11vnc novnc websockify fluxbox fonts-noto-core fonts-noto-extra && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY core.js browser-core.js gemini-browser.js ./
COPY server/*.mjs server/start.sh ./server/
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app && chmod +x /app/server/start.sh
USER pwuser
ENV DISPLAY=:99
CMD ["/bin/sh", "/app/server/start.sh"]
