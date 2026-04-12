import sys
content = open('index.html', encoding='utf-8').read()
lines = content.split('\n')
new_lines = lines[:190] + lines[230:]
open('index.html', 'w', encoding='utf-8').write('\n'.join(new_lines))
print('Done. Lines:', len(new_lines))
