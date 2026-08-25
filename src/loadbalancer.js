const routeState = new Map();

function getRouteState(route, config) {
    if (!routeState.has(route)) {
        const pool = config.backends[route];
        let totalWeight = 0;
        if (Array.isArray(pool)) {
            for (const backend of pool) {
                const weight = typeof backend === 'object' && backend.weight ? backend.weight : 1;
                totalWeight += weight;
            }
        }

        routeState.set(route, {
            index: 0,
            connections: new Map(),
            totalWeight: totalWeight,
        });
    }
    return routeState.get(route);
}

function getBackendUrl(entry) {
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'object' && entry !== null && entry.url) {
        return entry.url;
    }
    throw new Error(`Invalid backend entry: ${JSON.stringify(entry)}`);
}

function getBackendWeight(entry) {
    if (typeof entry === 'string') return 1;
    if (typeof entry === 'object' && entry !== null) {
        return entry.weight && typeof entry.weight === 'number' && entry.weight > 0
            ? entry.weight
            : 1;
    }
    return 1;
}

function isBackendHealthy(backendUrl, healthStatus) {
    if (!healthStatus) return true;
    if (typeof healthStatus.isHealthy === 'function') {
        return healthStatus.isHealthy(backendUrl);
    }
    if (healthStatus instanceof Map) {
        return healthStatus.get(backendUrl) !== false;
    }
    if (typeof healthStatus === 'object' && healthStatus !== null) {
        return healthStatus[backendUrl] !== false;
    }
    return true;
}

function pickRoundRobin(route, pool, config, healthStatus) {
    const state = getRouteState(route, config);

    const healthyBackends = [];
    for (const entry of pool) {
        const url = getBackendUrl(entry);
        if (isBackendHealthy(url, healthStatus)) {
            healthyBackends.push(entry);
        }
    }

    if (healthyBackends.length === 0) return null;

    const index = state.index % healthyBackends.length;
    state.index = (state.index + 1) % healthyBackends.length;

    return getBackendUrl(healthyBackends[index]);
}

function pickLeastConnections(route, pool, config, healthStatus) {
    const state = getRouteState(route, config);

    let bestBackend = null;
    let bestConnections = Infinity;

    for (const entry of pool) {
        const url = getBackendUrl(entry);
        if (!isBackendHealthy(url, healthStatus)) continue;

        const connections = state.connections.get(url) || 0;
        if (connections < bestConnections) {
            bestConnections = connections;
            bestBackend = url;
        }
    }

    return bestBackend;
}

function pickWeighted(route, pool, config, healthStatus) {
    const state = getRouteState(route, config);

    const healthyEntries = [];
    let totalWeight = 0;
    for (const entry of pool) {
        const url = getBackendUrl(entry);
        if (isBackendHealthy(url, healthStatus)) {
            const weight = getBackendWeight(entry);
            healthyEntries.push({ entry, url, weight });
            totalWeight += weight;
        }
    }

    if (healthyEntries.length === 0) return null;

    if (totalWeight === 0) return pickRoundRobin(route, pool, config, healthStatus);

    const random = Math.random() * totalWeight;
    let cumulative = 0;

    for (const item of healthyEntries) {
        cumulative += item.weight;
        if (random < cumulative) {
            return item.url;
        }
    }

    return healthyEntries[0].url;
}

export function createLoadBalancer(config, healthStatus = null) {
    const strategy = config.loadBalancing || 'round-robin';

    if (!['round-robin', 'least-connections', 'weighted'].includes(strategy)) {
        throw new Error(`Invalid load balancing strategy: ${strategy}`);
    }

    const strategyMap = {
        'round-robin': pickRoundRobin,
        'least-connections': pickLeastConnections,
        'weighted': pickWeighted,
    };

    const pickFn = strategyMap[strategy];

    return {
        pickBackend(route) {
            const pool = config.backends[route];
            if (!pool || !Array.isArray(pool) || pool.length === 0) {
                return null;
            }
            return pickFn(route, pool, config, healthStatus);
        },

        incrementConnections(route, backendUrl) {
            const state = getRouteState(route, config);
            const current = state.connections.get(backendUrl) || 0;
            state.connections.set(backendUrl, current + 1);
        },

        decrementConnections(route, backendUrl) {
            const state = getRouteState(route, config);
            const current = state.connections.get(backendUrl) || 0;
            if (current <= 1) {
                state.connections.delete(backendUrl);
            } else {
                state.connections.set(backendUrl, current - 1);
            }
        },

        getConnections(route, backendUrl) {
            const state = getRouteState(route, config);
            return state.connections.get(backendUrl) || 0;
        },

        setHealthStatus(newHealthStatus) {
            healthStatus = newHealthStatus;
        },

        async withConnection(route, backendUrl, fn) {
            this.incrementConnections(route, backendUrl);
            try {
                return await fn();
            } finally {
                this.decrementConnections(route, backendUrl);
            }
        },

        getStrategy() {
            return strategy;
        },

        resetRoute(route) {
            routeState.delete(route);
        },

        resetAll() {
            routeState.clear();
        },
    };
}

export function pickBackend(route, pool, config, loadBalancer) {
    if (loadBalancer && typeof loadBalancer.pickBackend === 'function') {
        return loadBalancer.pickBackend(route);
    }

    const lb = createLoadBalancer(config);
    return lb.pickBackend(route);
}

export function getRouteStateForTesting(route, config) {
    return getRouteState(route, config);
}