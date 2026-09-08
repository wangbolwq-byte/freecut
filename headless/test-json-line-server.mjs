import net from 'node:net'

export async function listenJsonLineServer(endpoint, handleRequest) {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk
      const newline = input.indexOf('\n')
      if (newline === -1) return
      const request = JSON.parse(input.slice(0, newline))
      socket.end(`${JSON.stringify({ ok: true, result: handleRequest(request) })}\n`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
  return server
}
