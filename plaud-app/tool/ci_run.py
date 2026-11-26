"""Keep the failing command's diagnostics in the GitHub check annotation."""
from collections import deque
import subprocess
import sys

tail = deque(maxlen=60)
process = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True)
for line in process.stdout:
    print(line, end="", flush=True)
    tail.append(line.rstrip())
status = process.wait()
if status:
    message = "\n".join(tail)[-12000:]
    escaped = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::error::{escaped}")
sys.exit(status)
