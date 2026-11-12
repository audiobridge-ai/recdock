"""Own the complete setup/probe process group for the desktop application's lifetime."""
from __future__ import annotations
import os
import signal
import subprocess
import sys


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 2 or args[0] != '-m' or args[1] not in {'recdock_audio.models', 'recdock_audio.preflight'}:
        raise SystemExit('Unsupported desktop task')
    child = subprocess.Popen([sys.executable, *args], start_new_session=True)
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        if stopping:
            return
        stopping = True
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    result = child.wait()
    raise SystemExit(130 if stopping else result)


if __name__ == '__main__':
    main()
