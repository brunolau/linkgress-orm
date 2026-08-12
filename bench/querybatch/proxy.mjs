// Latency-injecting TCP proxy: forwards 127.0.0.1:<listenPort> -> 127.0.0.1:<targetPort>
// delaying every chunk by <delayMs> in EACH direction (so RTT grows by ~2*delayMs).
// Bytes written back-to-back coalesce into shared timer windows — like real network RTT,
// pipelined traffic pays the latency once per direction, not once per query.
// Usage: node proxy.mjs <listenPort> <targetPort> <delayMs>
import net from 'node:net';

const [listenPort, targetPort, delayMs] = process.argv.slice(2).map(Number);

if (!listenPort || !targetPort || !(delayMs >= 0)) {
	console.error('usage: node proxy.mjs <listenPort> <targetPort> <delayMs>');
	process.exit(1);
}

net
	.createServer((client) => {
		client.setNoDelay(true);
		const upstream = net.connect(targetPort, '127.0.0.1');
		upstream.setNoDelay(true);

		const forward = (from, to) => {
			from.on('data', (chunk) => {
				setTimeout(() => {
					if (!to.destroyed && to.writable) {
						to.write(chunk);
					}
				}, delayMs);
			});
		};

		forward(client, upstream);
		forward(upstream, client);

		const kill = () => {
			client.destroy();
			upstream.destroy();
		};

		client.on('error', kill);
		upstream.on('error', kill);
		client.on('close', () => setTimeout(kill, delayMs * 2 + 50));
		upstream.on('close', () => setTimeout(kill, delayMs * 2 + 50));
	})
	.listen(listenPort, '127.0.0.1', () => {
		console.log(`proxy listening :${listenPort} -> :${targetPort} +${delayMs}ms/direction`);
	});
