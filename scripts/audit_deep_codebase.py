import os
import re

root_dir = 'Livora-api-service/src'
file_stats = []

for dirpath, _, filenames in os.walk(root_dir):
    for f in filenames:
        if f.endswith('.ts') and not f.endswith('.spec.ts'):
            fp = os.path.join(dirpath, f)
            rel_path = os.path.relpath(fp, root_dir)
            with open(fp, 'r', encoding='utf-8', errors='ignore') as fl:
                content = fl.read()
                lines = content.splitlines()
                
                commented_code = 0
                for line in lines:
                    stripped = line.strip()
                    if stripped.startswith('//') and any(kw in stripped for kw in ['const ', 'let ', 'function ', 'await ', 'return ', 'if (', 'this.']):
                        commented_code += 1
                
                any_count = len(re.findall(r':\s*any\b', content))
                
                file_stats.append({
                    'path': rel_path,
                    'lines': len(lines),
                    'any_count': any_count,
                    'commented_code': commented_code,
                })

file_stats.sort(key=lambda x: x['lines'], reverse=True)
print(f'Total non-spec TS files: {len(file_stats)}')
print('\n--- Files > 400 lines ---')
for s in file_stats:
    if s['lines'] > 400:
        print(f"{s['lines']:5d} lines | {s['any_count']:3d} any | {s['commented_code']:2d} dead comments | {s['path']}")
