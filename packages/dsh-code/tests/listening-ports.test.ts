import { describe, expect, it } from 'vitest'
import { parseListeningPorts } from '../src/core/workspaces.ts'

const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1435 0100007F:B2D4 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1
`
const tcp6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:22B8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5 1 0000000000000000 100 0 0 10 0
`

describe('listening ports from /proc/net', () => {
  it('lists LISTEN sockets only, marking loopback-only ports', () => {
    expect(parseListeningPorts(tcp + tcp6)).toEqual([
      { port: 3000, localOnly: true },   // 127.0.0.1:3000
      { port: 5173, localOnly: false },  // [::]:5173 (the established 127.0.0.1:5173 connection is ignored)
      { port: 8000, localOnly: false },  // 0.0.0.0:8000
      { port: 8888, localOnly: true },   // [::1]:8888
    ])
  })

  it('treats a port as reachable when any of its sockets is not loopback', () => {
    const both = '0: 0100007F:1F90 00000000:0000 0A\n1: 00000000:1F90 00000000:0000 0A\n'
    expect(parseListeningPorts(both)).toEqual([{ port: 8080, localOnly: false }])
    expect(parseListeningPorts('')).toEqual([])
  })
})
