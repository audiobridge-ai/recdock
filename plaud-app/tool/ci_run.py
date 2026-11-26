"""Keep the failing command's diagnostics in the GitHub check annotation."""
from collections import deque
import subprocess
import sys

tail = deque(maxlen=300)
process = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True)
for line in process.stdout:
    print(line, end="", flush=True)
    tail.append(line.rstrip())
status = process.wait()
if status:
    message = "\n".join(tail)[-24000:]
    for start in range(0, len(message), 2500):
        chunk = message[start:start + 2500]
        escaped = chunk.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::error::Diagnostic {start // 2500 + 1}: {escaped}")
sys.exit(status)
