import os
import re

SRC_DIR = r"c:\Users\Acer\Desktop\Estudio\Proyectos\Livora-ToStellar\Livora-api-service\src"

def analyze_patterns():
    findings = {
        "blob_candidates": [],
        "large_methods": [],
        "duplicate_candidates": [],
        "commented_code": [],
        "patterns_detected": {
            "Strategy": [],
            "State": [],
            "Factory": [],
            "Builder": [],
            "Adapter": [],
            "Facade": [],
            "Proxy": [],
            "Observer": [],
            "ChainOfResp": [],
            "Repository": [],
            "DTO": []
        }
    }

    all_methods = {}

    for root, dirs, files in os.walk(SRC_DIR):
        for f in files:
            if not f.endswith(".ts") or f.endswith(".spec.ts"):
                continue
            path = os.path.join(root, f)
            rel = os.path.relpath(path, SRC_DIR)
            with open(path, "r", encoding="utf-8", errors="ignore") as fp:
                lines = fp.readlines()
            
            content = "".join(lines)
            
            # 1. The Blob detector
            if len(lines) > 400:
                findings["blob_candidates"].append((rel, len(lines)))
            
            # 2. Large methods detector (> 60 lines)
            curr_method = None
            curr_start = 0
            brace_count = 0
            for i, line in enumerate(lines):
                # Simple method detector
                m = re.match(r"^\s*(public\s+|private\s+|protected\s+|async\s+)+(\w+)\s*\(", line)
                if m and not line.strip().startswith("//") and not line.strip().startswith("/*"):
                    if curr_method and (i - curr_start > 70):
                        findings["large_methods"].append((rel, curr_method, i - curr_start))
                    curr_method = m.group(2)
                    curr_start = i
                
                # Lava Flow: Commented out code blocks (> 5 consecutive lines starting with //)
            comment_run = 0
            for i, line in enumerate(lines):
                l = line.strip()
                if l.startswith("//") and any(k in l for k in ["const ", "let ", "var ", "function ", "return ", "if (", "await "]):
                    comment_run += 1
                else:
                    if comment_run >= 4:
                        findings["commented_code"].append((rel, i - comment_run, comment_run))
                    comment_run = 0

            # Patterns detection
            if "strategy" in content.lower():
                findings["patterns_detected"]["Strategy"].append(rel)
            if "state" in content.lower() and ("statemachine" in content.lower() or "transition" in content.lower()):
                findings["patterns_detected"]["State"].append(rel)
            if "factory" in content.lower() or "create(" in content:
                findings["patterns_detected"]["Factory"].append(rel)
            if "builder" in content.lower():
                findings["patterns_detected"]["Builder"].append(rel)
            if "adapter" in content.lower():
                findings["patterns_detected"]["Adapter"].append(rel)
            if "facade" in content.lower():
                findings["patterns_detected"]["Facade"].append(rel)
            if "proxy" in content.lower():
                findings["patterns_detected"]["Proxy"].append(rel)
            if "@OnEvent" in content or "EventEmitter" in content or "emit(" in content:
                findings["patterns_detected"]["Observer"].append(rel)
            if "CanActivate" in content or "NestInterceptor" in content or "ExceptionFilter" in content:
                findings["patterns_detected"]["ChainOfResp"].append(rel)
            if "repository" in content.lower():
                findings["patterns_detected"]["Repository"].append(rel)
            if ".dto.ts" in rel:
                findings["patterns_detected"]["DTO"].append(rel)

    print("=== AUDIT RESULTS ===")
    print(f"Total DTOs: {len(findings['patterns_detected']['DTO'])}")
    print(f"Total Blob Candidates (>400 lines): {len(findings['blob_candidates'])}")
    for rel, count in findings['blob_candidates']:
        print(f"  - {rel} ({count} lines)")
    
    print("\nLarge Methods (>70 lines):", len(findings['large_methods']))
    for rel, meth, sz in findings['large_methods'][:10]:
        print(f"  - {rel} :: {meth} ({sz} lines)")

    print("\nCommented Out Code Blocks (Lava Flow):", len(findings['commented_code']))
    for rel, line_no, cnt in findings['commented_code'][:10]:
        print(f"  - {rel} at line {line_no} ({cnt} lines)")

    print("\nPatterns Detected:")
    for pat, files in findings["patterns_detected"].items():
        if pat != "DTO":
            print(f"  - {pat}: {len(files)} files")

if __name__ == "__main__":
    analyze_patterns()
