import os
import re

SRC_DIR = r"Livora-api-service/src"

class_stats = []

for root, _, files in os.walk(SRC_DIR):
    for f in files:
        if f.endswith('.ts') and not f.endswith('.spec.ts'):
            path = os.path.join(root, f)
            rel = os.path.relpath(path, SRC_DIR)
            with open(path, 'r', encoding='utf-8', errors='ignore') as fp:
                content = fp.read()
            
            # Find classes
            classes = re.findall(r'export\s+(?:abstract\s+)?class\s+(\w+)', content)
            for cls in classes:
                # Count methods
                methods = len(re.findall(r'(?:public|private|protected|async)\s+(\w+)\s*\(', content))
                # Count properties
                props = len(re.findall(r'(?:public|private|protected|readonly)\s+(\w+)(?:\s*:\s*|\s*=)', content))
                class_stats.append({
                    'class': cls,
                    'file': rel,
                    'methods': methods,
                    'props': props,
                    'total': methods + props
                })

class_stats.sort(key=lambda x: x['methods'], reverse=True)
print('--- Classes with most methods (The Blob check: > 60 members) ---')
for c in class_stats[:20]:
    print(f"{c['class']:35s} | methods: {c['methods']:2d} | props: {c['props']:2d} | total: {c['total']:2d} | {c['file']}")
