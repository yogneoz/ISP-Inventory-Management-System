import io, json, re, sys

readme = io.open('README.md', encoding='utf-8').read()
lines = readme.split('\n')
problems = []

# ---- code fences ----
fences = [i for i, l in enumerate(lines, 1) if l.startswith('```')]
if len(fences) % 2 != 0:
    problems.append('odd number of code fences: %d' % len(fences))

# ---- tables ----
i = 0
tables = 0
while i < len(lines):
    if lines[i].startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+\|$', lines[i + 1].strip()):
        header = [c for c in lines[i].strip().strip('|').split('|')]
        sep = [c for c in lines[i + 1].strip().strip('|').split('|')]
        tables += 1
        if len(header) != len(sep):
            problems.append('table at line %d: header %d cols vs separator %d' % (i + 1, len(header), len(sep)))
        j = i + 2
        while j < len(lines) and lines[j].startswith('|'):
            cells = lines[j].strip().strip('|').split('|')
            if len(cells) != len(header):
                problems.append('table at line %d: row %d has %d cells vs %d header cols'
                                % (i + 1, j + 1, len(cells), len(header)))
            j += 1
        i = j
        continue
    i += 1

# ---- headings / step numbering ----
steps = [(n, l) for n, l in enumerate(lines, 1) if re.match(r'^### Step ', l)]
seen = []
for n, l in steps:
    label = re.match(r'^### (Step [0-9]+[a-z]?):', l)
    seen.append((n, label.group(1) if label else l.strip()))
# two sequences: install guide, then production guide; report the labels in order
labels = [s[1] for s in seen]
install = labels[:5]
prod = labels[5:]

# ---- env vars ----
env_example = {}
for line in io.open('.env.example', encoding='utf-8').read().split('\n'):
    m = re.match(r'^#?\s*([A-Z][A-Z0-9_]+)=', line)
    if m:
        env_example[m.group(1)] = True

readme_env = set(re.findall(r'^([A-Z][A-Z0-9_]+)=', readme, re.M))
missing_in_example = sorted(v for v in readme_env if v not in env_example)
readme_commented = set(re.findall(r'^#\s*([A-Z][A-Z0-9_]+)=', readme, re.M))
missing_commented = sorted(v for v in readme_commented if v not in env_example)

# ---- npm scripts ----
pkg = json.load(io.open('package.json', encoding='utf-8'))
scripts = set(pkg.get('scripts', {}).keys())
referenced = set(re.findall(r'npm run ([a-zA-Z0-9:_-]+)', readme))
missing_scripts = sorted(s for s in referenced if s not in scripts)

print('fences=%d tables=%d' % (len(fences), tables))
print('install steps: %s' % install)
print('production steps: %s' % prod)
print('readme env vars: %s' % sorted(readme_env))
print('env vars in README but NOT in .env.example: %s' % missing_in_example)
print('commented env vars in README but NOT in .env.example: %s' % missing_commented)
print('npm scripts referenced but missing from package.json: %s' % missing_scripts)
print('engines: %s' % pkg.get('engines'))
print('PROBLEMS: %s' % (problems if problems else 'none'))
