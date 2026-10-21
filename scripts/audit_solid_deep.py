import os
import re

SRC_DIR = r"Livora-api-service/src"

services = []

for root, _, files in os.walk(SRC_DIR):
    for f in files:
        if f.endswith('.service.ts') and not f.endswith('.spec.ts'):
            path = os.path.join(root, f)
            rel = os.path.relpath(path, SRC_DIR)
            with open(path, 'r', encoding='utf-8', errors='ignore') as fp:
                lines = fp.readlines()
            
            content = "".join(lines)
            
            # Count imports of external concrete libraries
            external_libs = []
            for line in lines:
                if 'from ' in line and any(pkg in line for pkg in ['@stellar', 'pdfkit', 'axios', 'nodemailer', 'bcrypt', 'crypto']):
                    external_libs.append(line.strip())
            
            # Count switch/if-else ladders on types/roles/statuses
            switch_cases = len(re.findall(r'\bcase\s+[\'"]?\w+[\'"]?:', content))
            if_type_ladders = len(re.findall(r'if\s*\([^)]*(?:role|status|type)\s*===', content))
            
            # Count Prisma direct calls
            prisma_calls = len(re.findall(r'this\.prisma\.\w+\.(?:find|create|update|delete|count|upsert)', content))
            
            services.append({
                'file': rel,
                'lines': len(lines),
                'external_libs': external_libs,
                'switch_cases': switch_cases,
                'if_type_ladders': if_type_ladders,
                'prisma_calls': prisma_calls,
            })

services.sort(key=lambda x: x['lines'], reverse=True)

print(f"Total service files: {len(services)}")
print("\n--- Services > 300 lines or high complexity ---")
for s in services:
    if s['lines'] > 250 or s['switch_cases'] > 5 or s['if_type_ladders'] > 5:
        print(f"{s['file']:55s} | lines: {s['lines']:4d} | prisma: {s['prisma_calls']:2d} | switches: {s['switch_cases']:2d} | type_ifs: {s['if_type_ladders']:2d} | ext_libs: {len(s['external_libs'])}")
