#!/usr/bin/env python3
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent
output = root / 'dist'
output.mkdir(exist_ok=True)
for name in ['index.html', 'styles.css', 'demo.js', 'logo.svg', 'locales.js']:
    shutil.copyfile(root / name, output / name)
print('Prepared buildless website in', output)
