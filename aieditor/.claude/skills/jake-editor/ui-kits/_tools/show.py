import json,sys
d=json.load(open(sys.argv[1])); print(d.get('error'), d.get('rootBox'), len(d.get('nodes',[])))
stack=[]
SKIP={'width','height','flex-direction','box-sizing','position','border-top','border-bottom'}
for n in d.get('nodes',[]):
  stack=stack[:n['depth']]; par=stack[-1] if stack else {}
  diff={k:v for k,v in n['st'].items() if par.get(k)!=v and k not in SKIP and not (k=='border' and v.startswith('0px'))}
  stack.append(n['st'])
  a={k:v for k,v in n['attrs'].items() if k not in('d',) and not k.startswith('data-composer')}
  print('  '*n['depth']+n['tag'], n['box'], repr(n['text'])[:60], json.dumps(a)[:140], '|', '; '.join(f'{k}:{v}' for k,v in diff.items())[:500])
