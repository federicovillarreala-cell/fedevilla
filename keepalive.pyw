"""Keeps the Gridiron IQ server running in the background (no window).

Windows starts this at login via the "Gridiron IQ server" shortcut in your Startup folder.
If the server ever stops, it is restarted a few seconds later. If something is already
serving the port (e.g. you started the app another way), this just waits.
Output goes to server.log next to this file.
"""
import os
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 5190
LOG = os.path.join(ROOT, "server.log")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def port_busy():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def main():
    if os.path.exists(LOG) and os.path.getsize(LOG) > 1_000_000:
        os.replace(LOG, LOG + ".old")
    while True:
        if port_busy():
            time.sleep(30)
            continue
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(f"\n--- starting server {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
            log.flush()
            proc = subprocess.Popen([sys.executable, "-u", os.path.join(ROOT, "server.py"), str(PORT)],
                                    cwd=ROOT, stdout=log, stderr=log, creationflags=NO_WINDOW)
            proc.wait()
            log.write(f"--- server exited with code {proc.returncode}; restarting in 5s ---\n")
        time.sleep(5)


if __name__ == "__main__":
    main()
