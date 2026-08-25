export function createDashboard(config, metrics) {
    const pushIntervalMs = config.dashboard?.pushIntervalMs || 1000;

    return {
        handleDashboardStream(req, res) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            });

            if (typeof res.flushHeaders === 'function') res.flushHeaders();

            const send = () => {
                const snapshot = metrics.getSnapshot();
                res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
            };

            send();
            const timer = setInterval(send, pushIntervalMs);

            const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);

            const cleanup = () => {
                clearInterval(timer);
                clearInterval(keepAlive);
            };

            req.on('close', cleanup);
            res.on('close', cleanup);
        },
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const http = await import('node:http');
    const { createMetrics } = await import('./metrics.js');

    const metrics = createMetrics();

    setInterval(() => {
        metrics.recordRequest({
            route: '/api',
            backend: 'http://localhost:4001',
            statusCode: Math.random() < 0.1 ? 500 : 200,
            durationMs: Math.floor(50 + Math.random() * 200),
        });
    }, 500);

    const dashboard = createDashboard({ dashboard: { pushIntervalMs: 1000 } }, metrics);
    const server = http.default.createServer((req, res) => {
        if (req.url === '/nexus/dashboard/stream') {
            return dashboard.handleDashboardStream(req, res);
        }
        res.writeHead(404).end();
    });

    server.listen(5055, () => console.log('dashboard smoke test on http://localhost:5055/nexus/dashboard/stream'));
}