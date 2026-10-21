import os
import re

SRC_DIR = r"Livora-api-service/src"
lava_flow_candidates = []

for root, _, files in os.walk(SRC_DIR):
    for f in files:
        if f.endswith('.ts') and not f.endswith('.spec.ts'):
            path = os.path.join(root, f)
            rel = os.path.relpath(path, SRC_DIR)
            with open(path, 'r', encoding='utf-8', errors='ignore') as fp:
                lines = fp.readlines()
            
            for idx, line in enumerate(lines):
                s = line.strip()
                # Check for commented-out code keywords
                if s.startswith('//') and not s.startswith('///'):
                    rest = s[2:].strip()
                    # If line looks like code rather than a documentation comment
                    if any(rest.startswith(kw) for kw in ['const ', 'let ', 'var ', 'function ', 'await ', 'return ', 'if (', 'for (', 'while (', 'this.', 'import ']):
                        lava_flow_candidates.append((rel, idx + 1, s))

print(f"Total potential Lava Flow commented-out code lines: {len(lava_flow_candidates)}")
for rel, line_no, content in lava_flow_candidates:
    print(f"{rel}:{line_no} -> {content}")
