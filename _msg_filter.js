
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const out = d.replace(/
Co-Authored-By:[^
]*/g,'').trimEnd();
  process.stdout.write(out+'
');
});
