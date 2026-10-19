# For hosts that run containers (Fly.io, Railway, Koyeb...). Set GIQ_PASSCODE on the host.
FROM python:3.12-slim
WORKDIR /app
COPY server.py index.html app.js engine.js games.js props.js espn.js live.js design.css styles.css sw.js manifest.webmanifest ./
COPY icons ./icons
ENV GIQ_CLOUD=1 PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "server.py"]
