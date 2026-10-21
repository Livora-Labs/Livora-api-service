import os
import hashlib
from collections import defaultdict

SRC_DIR = r"Livora-api-service/src"

line_hashes = defaultdict(list)
BLOCK_SIZE = 8

for root, _, files in os.walk(SRC_DIR):
    for f in files:
        if f.endswith('.ts') and not f.endswith('.spec.ts') and not f.endswith('.module.ts'):
            path = os.path.join(root, f)
            rel = os.path.relpath(path, SRC_DIR)
            with open(path, 'r', encoding='utf-8', errors='ignore') as fp:
                raw_lines = fp.readlines()
            
            clean_lines = []
            for i, line in enumerate(raw_lines):
                s = line.strip()
                if s and not s.startswith('//') and not s.startswith('/*') and not s.startswith('*') and not s.startswith('import ') and s not in ['{', '}', '};', '});']:
                    clean_lines.append((i + 1, s))
            
            for j in range(len(clean_lines) - BLOCK_SIZE + 1):
                block = '\n'.join([clean_lines[j + k][1] for k in range(BLOCK_SIZE)])
                if 'constructor(' in block or '@Api' in block or '@Is' in block:
                    continue
                h = hashlib.md5(block.encode('utf-8')).hexdigest()
                line_hashes[h].append((rel, clean_lines[j][0]))

duplicate_blocks = {h: locs for h, locs in line_hashes.items() if len(set(loc[0] for loc in locs)) > 1}

print(f"Total cross-file service/logic duplicate blocks (>={BLOCK_SIZE} lines): {len(duplicate_blocks)}")
for h, locs in list(duplicate_blocks.items())[:15]:
    unique_files = list(set(loc[0] for loc in locs))
    print(f"Duplicate between: {unique_files} -> lines {[loc[1] for loc in locs]}")
