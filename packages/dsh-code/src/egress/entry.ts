/** Egress proxy container entry: `node entry.ts <policy.json> <port>`. */
import { main } from './proxy.ts'

main(process.argv[2] ?? '/opt/egress/policy.json', Number(process.argv[3] ?? 3128))
