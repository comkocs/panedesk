/** Byte relay for exercising the public SDK clients against the in-process production server. */
import { connect } from 'node:net'

const socket = connect({ host: 'localhost', port: Number(process.argv[2]) })
socket.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
process.stdin.pipe(socket)
socket.pipe(process.stdout)
process.stdin.on('end', () => { socket.end() })
