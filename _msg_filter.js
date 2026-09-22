
let message = ''
process.stdin.on('data', chunk => { message += chunk })
process.stdin.on('end', () => {
  const filtered = message.replace(/^Co-Authored-By:[^\r\n]*(?:\r?\n|$)/gim, '').trimEnd()
  process.stdout.write(`${filtered}\n`)
})
